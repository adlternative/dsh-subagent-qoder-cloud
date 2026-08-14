/**
 * Qoder Cloud Agent subagent provider for DeepSeek Harness.
 *
 * Delegates tasks to a remote Qoder Cloud Agent via the Qoder Cloud API:
 *   1. POST /sessions — create session bound to agent + environment
 *   2. POST /sessions/{id}/events — send user message
 *   3. GET  /sessions/{id}/events/stream — SSE stream for agent response
 *
 * The child runs entirely in the cloud; dsh sees only the final text output.
 *
 * @module dsh-subagent-qoder-cloud
 */

import type { Context } from '@deepseek-ai/cordis'

// ─── Config ──────────────────────────────────────────────────────────────────

export interface Config {
  /** Provider name registered on ctx.subagents (default 'qoder-cloud'). */
  providerName?: string
  /** Qoder Cloud API base URL. */
  apiBase?: string
  /** Env var name holding the Qoder PAT (default 'QODER_PAT'). */
  patEnv?: string
  /** Default Agent ID to delegate to. */
  agentId: string
  /** Default Environment ID for the cloud session. */
  environmentId: string
  /** Timeout for the whole run in ms (default 600_000 = 10min). */
  timeoutMs?: number
}

// ─── Types (matches dsh-subagent contract) ───────────────────────────────────

interface SubagentCapabilities {
  readonly outputSchema: boolean
  readonly depthLimit: boolean
  readonly toolFilter: boolean
  readonly persona: boolean
}

interface ContentBlock {
  type: string
  text?: string
  [key: string]: unknown
}

interface SubagentResult {
  readonly output: ContentBlock[]
  readonly structured?: unknown
  readonly stopReason: string
}

interface SubagentRun {
  readonly id: string
  readonly localAgent: undefined
  readonly result: Promise<SubagentResult>
  dispose(): Promise<void>
}

interface SubagentStartRequest {
  readonly label?: string
  readonly prompt: ContentBlock[]
  readonly parent: { session: { id: string; header: { cwd?: string } } }
  readonly signal: AbortSignal
  readonly descriptor?: unknown
}

interface SubagentProvider {
  readonly name: string
  readonly capabilities: SubagentCapabilities
  readonly inheritsParentContext: boolean
  start(request: SubagentStartRequest): Promise<SubagentRun>
}

// ─── API helpers ─────────────────────────────────────────────────────────────

interface QoderSession {
  id: string
  status: string
}

async function qoderFetch(
  url: string,
  pat: string,
  options: RequestInit = {},
): Promise<Response> {
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${pat}`,
      'Content-Type': 'application/json',
      ...options.headers as Record<string, string>,
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Qoder API ${res.status}: ${body.slice(0, 500)}`)
  }
  return res
}

async function createSession(
  apiBase: string,
  pat: string,
  agentId: string,
  environmentId: string,
  title?: string,
): Promise<QoderSession> {
  const res = await qoderFetch(`${apiBase}/sessions`, pat, {
    method: 'POST',
    body: JSON.stringify({
      agent: agentId,
      environment_id: environmentId,
      title: title ?? 'dsh subagent delegation',
    }),
  })
  return res.json() as Promise<QoderSession>
}

async function pushEvent(
  apiBase: string,
  pat: string,
  sessionId: string,
  content: string,
): Promise<void> {
  await qoderFetch(`${apiBase}/sessions/${sessionId}/events`, pat, {
    method: 'POST',
    body: JSON.stringify({
      events: [
        {
          type: 'user.message',
          content: [{ type: 'text', text: content }],
        },
      ],
    }),
  })
}

/**
 * Subscribe to SSE event stream and collect the agent's response.
 * Streams from the start; uses sawRunning to skip initial idle state.
 * Resolves when session goes idle (after running) or an error occurs.
 */
function streamResponse(
  apiBase: string,
  pat: string,
  sessionId: string,
  signal: AbortSignal,
): Promise<SubagentResult> {
  return new Promise<SubagentResult>(async (resolve) => {
    const chunks: string[] = []
    let stopReason: string = 'completed'

    try {
      const res = await fetch(
        `${apiBase}/sessions/${sessionId}/events/stream`,
        {
          headers: {
            'Authorization': `Bearer ${pat}`,
            'Accept': 'text/event-stream',
          },
          signal,
        },
      )

      if (!res.ok || !res.body) {
        resolve({
          output: [{ type: 'text', text: `SSE connection failed: ${res.status}` }],
          stopReason: 'error',
        })
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let currentEvent = ''
      let sawRunning = false

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        let breakOuter = false

        for (const line of lines) {
          // SSE format: "event: <type>" then "data: <json>" then blank line
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim()
            continue
          }
          if (line.startsWith(': ')) continue // comment/heartbeat
          if (!line.startsWith('data: ')) {
            if (line === '') currentEvent = ''
            continue
          }

          const raw = line.slice(6).trim()
          if (!raw || raw === '[DONE]') continue

          try {
            const data = JSON.parse(raw)
            const eventType = currentEvent || data.type || ''

            // Track running state
            if (eventType === 'session.status_running') {
              sawRunning = true
            }

            // Collect agent message text (content is an array of blocks)
            if (eventType === 'agent.message' || eventType === 'agent.message.delta') {
              const content = data.content
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === 'text' && block.text) chunks.push(block.text)
                }
              } else if (data.delta?.text) {
                chunks.push(data.delta.text)
              }
            }

            // Session went idle AFTER running = turn complete
            if (eventType === 'session.status_idle' && sawRunning) {
              stopReason = 'completed'
              breakOuter = true
              reader.cancel()
              break
            }

            // Error
            if (eventType === 'session.error' || eventType === 'error') {
              stopReason = 'error'
              const errMsg = data.message ?? data.error?.message ?? 'unknown error'
              chunks.push(`[Error: ${errMsg}]`)
              breakOuter = true
              reader.cancel()
              break
            }
          } catch {
            // Skip malformed SSE data lines
          }
        }
        if (breakOuter) break
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        stopReason = 'aborted'
      } else {
        stopReason = 'error'
        chunks.push(`[Stream error: ${err?.message ?? err}]`)
      }
    }

    const text = chunks.join('')
    resolve({
      output: text ? [{ type: 'text', text }] : [],
      stopReason,
    })
  })
}

// ─── Provider implementation ─────────────────────────────────────────────────

class QoderCloudProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = {
    outputSchema: false,
    depthLimit: false,
    toolFilter: false,
    persona: false,
  }
  readonly inheritsParentContext = false

  constructor(
    readonly name: string,
    private readonly apiBase: string,
    private readonly patEnv: string,
    private readonly agentId: string,
    private readonly environmentId: string,
    private readonly timeoutMs: number,
    private readonly logger: { warn: (msg: string) => void },
  ) {}

  private get pat(): string {
    const pat = process.env[this.patEnv]
    if (!pat) throw new Error(`dsh-subagent-qoder-cloud: env ${this.patEnv} is not set`)
    return pat
  }

  async start(request: SubagentStartRequest): Promise<SubagentRun> {
    // Extract text from prompt content blocks
    const promptText = request.prompt
      .map(b => b.text ?? '')
      .filter(Boolean)
      .join('\n')

    if (!promptText) {
      throw new Error('dsh-subagent-qoder-cloud: empty prompt')
    }

    // 1. Create session
    const session = await createSession(
      this.apiBase,
      this.pat,
      this.agentId,
      this.environmentId,
      request.label ?? 'dsh delegation',
    )

    // 2. Timeout + cancellation
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    request.signal.addEventListener('abort', () => controller.abort(), { once: true })

    // 3. Start SSE stream BEFORE pushing message (to not miss events)
    const resultPromise = streamResponse(
      this.apiBase,
      this.pat,
      session.id,
      controller.signal,
    ).finally(() => clearTimeout(timeout))

    // 4. Push user message to trigger the agent
    try {
      await qoderFetch(`${this.apiBase}/sessions/${session.id}/events`, this.pat, {
        method: 'POST',
        body: JSON.stringify({
          events: [{
            type: 'user.message',
            content: [{ type: 'text', text: promptText }],
          }],
        }),
      })
    } catch (err: any) {
      controller.abort()
      clearTimeout(timeout)
      throw new Error(`dsh-subagent-qoder-cloud: failed to push event: ${err?.message}`)
    }

    const apiBase = this.apiBase
    const patVal = this.pat

    const run: SubagentRun = {
      id: session.id,
      localAgent: undefined,
      result: resultPromise,
      async dispose() {
        controller.abort()
        // Best-effort: stop the cloud session
        try {
          await qoderFetch(`${apiBase}/sessions/${session.id}/cancel`, patVal, {
            method: 'POST',
            body: '{}',
          })
        } catch { /* ignore */ }
      },
    }

    return run
  }
}

// ─── Cordis plugin entry ─────────────────────────────────────────────────────

export const name = 'subagent-qoder-cloud'
export const inject = ['subagents']

export function apply(ctx: Context, config: Config): void {
  const apiBase = (config.apiBase ?? 'https://api.qoder.com/api/v1/cloud').replace(/\/$/, '')
  const patEnv = config.patEnv ?? 'QODER_PAT'
  const timeoutMs = config.timeoutMs ?? 600_000

  if (!config.agentId) throw new Error('dsh-subagent-qoder-cloud: config.agentId is required')
  if (!config.environmentId) throw new Error('dsh-subagent-qoder-cloud: config.environmentId is required')

  const provider = new QoderCloudProvider(
    config.providerName ?? 'qoder-cloud',
    apiBase,
    patEnv,
    config.agentId,
    config.environmentId,
    timeoutMs,
    ctx.logger,
  )

  // Register the provider — effect-based, auto-unregisters on plugin dispose
  ctx.subagents.register(provider as any)
}
