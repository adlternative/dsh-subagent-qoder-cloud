/**
 * Qoder Cloud Agent subagent provider for DeepSeek Harness.
 * Pure ESM JS — no TypeScript compilation needed.
 */

// ─── Agent Catalog ───────────────────────────────────────────────────────────

const AGENT_CATALOG = {
  '深度研究': {
    name: '深度研究',
    description: '多步骤网络调研，整合来源并附行内引用。',
    model: 'auto',
    system: `你是一个研究 Agent。给定一个问题或主题：

1. 将其拆解为 3-5 个具体的子问题，这些子问题合在一起足以覆盖整个主题。
2. 针对每个子问题，进行有针对性的网络搜索，抓取最权威的来源（优先选择一手资料、官方文档、同行评审作品，而非博客和聚合网站）。
3. 完整阅读来源——不要走马观花。提取具体论断、数据点和带出处的直接引述。
4. 综合输出一份回答原问题的报告。按子问题组织结构，对每个非显而易见的论断在行内标注引用，最后附"置信度与缺口"小节，说明来源分歧之处或你未能找到充分覆盖的部分。

保持怀疑。如果来源相互矛盾，明确指出，并解释你更信任哪一个、为什么。不要用自信的措辞掩盖不确定性。`,
    tools: [{ type: 'agent_toolset_20260401', enabled_tools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'ImageSearch', 'ImageGen', 'DeliverArtifacts'] }],
    mcp_servers: [],
  },
  '仓库分析': {
    name: '仓库分析',
    description: '克隆 GitHub 仓库并进行深度代码/架构分析。',
    model: 'ultimate',
    system: `你是一个代码仓库分析专家。给定一个 GitHub 仓库 URL：

1. 使用 git clone（shallow clone --depth=1 即可）将仓库下载到工作目录。
2. 分析仓库结构：语言组成、目录布局、核心模块划分。
3. 阅读 README、CONTRIBUTING、架构文档（如有），理解项目定位和设计理念。
4. 深入关键源码（入口文件、核心模块、类型定义），分析：
   - 整体架构模式（单体/微服务/插件化/分层等）
   - 核心抽象和数据流
   - 依赖关系和技术栈
   - 测试策略
5. 如需了解社区评价或对比信息，使用 WebSearch 搜索。
6. 输出结构化分析报告，包含：
   - 项目概述（一句话定位）
   - 技术栈
   - 架构设计（附目录树）
   - 核心实现亮点
   - 潜在问题或改进空间
   - 与同类项目对比（如适用）

要求：基于实际源码分析，不要臆测。引用具体文件路径和代码片段作为依据。输出中文。`,
    tools: [{ type: 'agent_toolset_20260401', enabled_tools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch'] }],
    mcp_servers: [],
  },
}

const DEFAULT_AGENT_NAME = '深度研究'

/**
 * Detect which agent to use based on prompt content.
 * Returns the catalog key or the default.
 */
function detectAgentType(promptText) {
  const lower = promptText.toLowerCase()
  // GitHub repo patterns
  if (
    /github\.com\/[\w-]+\/[\w.-]+/.test(promptText) ||
    /\b(clone|仓库|repo|repository|源码分析|代码分析|架构分析)\b/i.test(promptText)
  ) {
    return '仓库分析'
  }
  return DEFAULT_AGENT_NAME
}

export const name = 'subagent-qoder-cloud'
export const inject = ['subagents']

export function apply(ctx, config) {
  const apiBase = (config.apiBase ?? 'https://api.qoder.com/api/v1/cloud').replace(/\/$/, '')
  const patEnv = config.patEnv ?? 'QODER_CLOUD_PAT'
  const timeoutMs = config.timeoutMs ?? 600_000

  // ─── Environment resolution ───────────────────────────────────────────────
  const DEFAULT_ENV_NAME = 'dsh-subagent-env'
  let resolvedEnvId = config.environmentId || null

  async function ensureEnvironment() {
    if (resolvedEnvId) return resolvedEnvId

    // Find first usable cloud env (unrestricted network)
    try {
      const listRes = await qoderFetch(`${apiBase}/environments?limit=50`)
      const list = await listRes.json()
      const existing = (list.data || []).find(e =>
        e.config?.type === 'cloud'
        && e.config?.networking?.type === 'unrestricted'
        && !e.archived_at
      )
      if (existing) {
        resolvedEnvId = existing.id
        ctx.logger?.info?.(`subagent-qoder-cloud: using env "${existing.name}" (${existing.id})`)
        return resolvedEnvId
      }
    } catch (err) {
      ctx.logger?.warn?.(`subagent-qoder-cloud: failed to list envs: ${err?.message}`)
    }

    // None found — create one
    try {
      const createRes = await qoderFetch(`${apiBase}/environments`, {
        method: 'POST',
        body: JSON.stringify({
          name: DEFAULT_ENV_NAME,
          description: 'Auto-created by dsh-subagent-qoder-cloud plugin',
          config: {
            type: 'cloud',
            networking: { type: 'unrestricted', allow_mcp_servers: false, allow_package_managers: false, allowed_hosts: [] },
            packages: { type: 'packages', apt: [], pip: [], npm: [], go: [], cargo: [], gem: [] },
          },
        }),
      })
      const created = await createRes.json()
      resolvedEnvId = created.id
      ctx.logger?.info?.(`subagent-qoder-cloud: created env "${DEFAULT_ENV_NAME}" (${created.id})`)
      return resolvedEnvId
    } catch (err) {
      throw new Error(`dsh-subagent-qoder-cloud: failed to create environment: ${err?.message}`)
    }
  }

  function getPat() {
    const pat = process.env[patEnv]
    if (!pat) throw new Error(`dsh-subagent-qoder-cloud: env ${patEnv} is not set`)
    return pat
  }

  async function qoderFetch(url, options = {}) {
    const res = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${getPat()}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Qoder API ${res.status}: ${body.slice(0, 500)}`)
    }
    return res
  }

  // Agent cache: name → id
  const agentCache = new Map()

  async function ensureAgent(agentName) {
    // If config specifies an explicit agentId, always use it
    if (config.agentId) return config.agentId

    // Check cache
    if (agentCache.has(agentName)) return agentCache.get(agentName)

    const agentDef = AGENT_CATALOG[agentName]
    if (!agentDef) throw new Error(`dsh-subagent-qoder-cloud: unknown agent type "${agentName}"`)

    // Search for existing agent by name
    try {
      const listRes = await qoderFetch(`${apiBase}/agents?limit=50`)
      const list = await listRes.json()
      const existing = (list.data || []).find(a => a.name === agentName && !a.archived_at)
      if (existing) {
        agentCache.set(agentName, existing.id)
        ctx.logger?.info?.(`subagent-qoder-cloud: found "${agentName}" (${existing.id})`)
        return existing.id
      }
    } catch (err) {
      ctx.logger?.warn?.(`subagent-qoder-cloud: failed to list agents: ${err?.message}`)
    }

    // Not found — create it
    try {
      const createRes = await qoderFetch(`${apiBase}/agents`, {
        method: 'POST',
        body: JSON.stringify(agentDef),
      })
      const created = await createRes.json()
      agentCache.set(agentName, created.id)
      ctx.logger?.info?.(`subagent-qoder-cloud: created "${agentName}" (${created.id})`)
      return created.id
    } catch (err) {
      throw new Error(`dsh-subagent-qoder-cloud: failed to create agent "${agentName}": ${err?.message}`)
    }
  }

  async function streamResponse(sessionId, signal) {
    const chunks = []
    let stopReason = 'completed'

    try {
      const res = await fetch(
        `${apiBase}/sessions/${sessionId}/events/stream`,
        {
          headers: { 'Authorization': `Bearer ${getPat()}`, 'Accept': 'text/event-stream' },
          signal,
          // Keep TCP alive for long-running cloud agents
          keepalive: true,
        },
      )

      if (!res.ok || !res.body) {
        return { output: [{ type: 'text', text: `SSE failed: ${res.status}` }], stopReason: 'error' }
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let currentEvent = ''
      let sawRunning = false
      let lastActivityMs = Date.now()

      while (true) {
        // Check for stale connection (no data in 5 minutes = dead)
        const { done, value } = await reader.read()
        if (done) break

        lastActivityMs = Date.now()
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        let breakOuter = false

        for (const line of lines) {
          if (line.startsWith('event: ')) { currentEvent = line.slice(7).trim(); continue }
          if (line.startsWith(': ')) {
            // Heartbeat — connection is alive, reset timer
            lastActivityMs = Date.now()
            continue
          }
          if (!line.startsWith('data: ')) { if (line === '') currentEvent = ''; continue }

          const raw = line.slice(6).trim()
          if (!raw || raw === '[DONE]') continue

          try {
            const data = JSON.parse(raw)
            const eventType = currentEvent || data.type || ''

            if (eventType === 'session.status_running') sawRunning = true

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

            if (eventType === 'session.status_idle' && sawRunning) {
              const stopType = data.stop_reason?.type || 'end_turn'
              switch (stopType) {
                case 'end_turn':
                  stopReason = 'completed'
                  breakOuter = true
                  break
                case 'requires_action': {
                  // Agent needs tool confirmation — auto-approve all pending tools
                  const eventIds = data.stop_reason?.event_ids || []
                  for (const toolEventId of eventIds) {
                    qoderFetch(`${apiBase}/sessions/${sessionId}/events`, {
                      method: 'POST',
                      body: JSON.stringify({
                        events: [{
                          type: 'user.tool_confirmation',
                          tool_use_id: toolEventId,
                          result: 'allow',
                        }],
                      }),
                    }).catch(() => {})
                  }
                  // Session will resume — DON'T break, keep listening
                  sawRunning = false // reset: will see running again after approval
                  break
                }
                case 'max_turns':
                  stopReason = 'max-tokens'
                  chunks.push('[Agent hit max turns limit]')
                  breakOuter = true
                  break
                case 'cancel':
                  stopReason = 'aborted'
                  breakOuter = true
                  break
                case 'error':
                  stopReason = 'error'
                  chunks.push('[Agent encountered an error]')
                  breakOuter = true
                  break
                default:
                  stopReason = 'completed'
                  breakOuter = true
              }
            }

            if (eventType === 'session.error' || eventType === 'error') {
              stopReason = 'error'
              chunks.push(`[Error: ${data.message ?? data.error?.message ?? 'unknown'}]`)
              breakOuter = true
            }
          } catch {}
        }
        if (breakOuter) {
          reader.cancel().catch(() => {})
          break
        }
      }

      // If stream ended without seeing idle after running, the connection may have dropped
      // Fall back to polling the session status
      if (sawRunning && stopReason === 'completed' && chunks.length === 0) {
        stopReason = await pollForCompletion(sessionId, chunks, signal)
      }
    } catch (err) {
      if (err?.name === 'AbortError') {
        stopReason = 'aborted'
      } else {
        // SSE connection dropped — try to recover by polling
        stopReason = await pollForCompletion(sessionId, chunks, signal)
      }
    }

    const text = chunks.join('')
    return { output: text ? [{ type: 'text', text }] : [], stopReason }
  }

  // Fallback: poll session events when SSE drops
  async function pollForCompletion(sessionId, chunks, signal) {
    try {
      // Wait a bit then check status
      for (let i = 0; i < 60; i++) {
        if (signal.aborted) return 'aborted'
        await new Promise(r => setTimeout(r, 2000))

        const statusRes = await qoderFetch(`${apiBase}/sessions/${sessionId}`, {})
        const session = await statusRes.json()

        if (session.status === 'idle') {
          // Session done! Fetch the last agent.message
          const eventsRes = await qoderFetch(`${apiBase}/sessions/${sessionId}/events?limit=50&order=desc`, {})
          const events = await eventsRes.json()
          for (const e of (events.data || [])) {
            if (e.type === 'agent.message' && e.content) {
              const text = e.content.filter(b => b.type === 'text').map(b => b.text).join('')
              if (text) { chunks.push(text); break }
            }
          }
          return 'completed'
        }
      }
      return 'error' // timed out polling
    } catch {
      return 'error'
    }
  }

  // Register the Qoder Cloud subagent provider
  ctx.subagents.registerProvider({
    name: config.providerName ?? 'qoder-cloud',
    capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
    inheritsParentContext: false,

    async start(request) {
      // Extract text from prompt
      const promptText = request.prompt
        .map(b => b.text ?? '')
        .filter(Boolean)
        .join('\n')
      if (!promptText) throw new Error('dsh-subagent-qoder-cloud: empty prompt')

      // 1. Detect agent type from prompt and ensure it exists
      const agentType = detectAgentType(promptText)
      const agentId = await ensureAgent(agentType)

      // 2. Ensure environment exists
      const environmentId = await ensureEnvironment()

      // 3. Create session
      const sessRes = await qoderFetch(`${apiBase}/sessions`, {
        method: 'POST',
        body: JSON.stringify({
          agent: { id: agentId, type: 'agent' },
          environment_id: environmentId,
          title: request.label ?? 'dsh delegation',
        }),
      })
      const session = await sessRes.json()

      // 2. Setup cancellation
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), timeoutMs)
      request.signal.addEventListener('abort', () => controller.abort(), { once: true })

      // 3. Connect SSE stream BEFORE pushing (to not miss events)
      const resultPromise = streamResponse(session.id, controller.signal)
        .finally(() => clearTimeout(timeout))

      // 4. Push user message
      try {
        await qoderFetch(`${apiBase}/sessions/${session.id}/events`, {
          method: 'POST',
          body: JSON.stringify({
            events: [{
              type: 'user.message',
              content: [{ type: 'text', text: promptText }],
            }],
          }),
        })
      } catch (err) {
        controller.abort()
        clearTimeout(timeout)
        throw new Error(`dsh-subagent-qoder-cloud: push failed: ${err?.message}`)
      }

      return {
        id: session.id,
        localAgent: undefined,
        result: resultPromise,
        async dispose() {
          controller.abort()
          try { await qoderFetch(`${apiBase}/sessions/${session.id}/cancel`, { method: 'POST', body: '{}' }) } catch {}
        },
      }
    },
  })

  ctx.logger?.info?.(`subagent-qoder-cloud: registered provider "${config.providerName ?? 'qoder-cloud'}" (agent=${config.agentId ?? 'auto-route'}, env=${config.environmentId ?? 'auto-discover'})`)
}
