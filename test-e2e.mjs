const QODER_PAT = process.env.QODER_PAT
const API_BASE = 'https://api.qoder.com/api/v1/cloud'
const AGENT_ID = process.env.TEST_AGENT_ID || 'agent_your_agent_id_here'
const ENV_ID = process.env.TEST_ENV_ID || 'env_your_env_id_here'

async function main() {
  console.log('=== dsh-subagent-qoder-cloud E2E Test v3 ===\n')

  // 1. Create session
  const session = await (await fetch(`${API_BASE}/sessions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${QODER_PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: AGENT_ID, environment_id: ENV_ID, title: 'e2e v3' }),
  })).json()
  console.log(`1. Session: ${session.id}`)

  // 2. Connect SSE FIRST (no after_id)
  console.log('2. Connecting SSE...')
  const sseRes = await fetch(`${API_BASE}/sessions/${session.id}/events/stream`, {
    headers: { 'Authorization': `Bearer ${QODER_PAT}`, 'Accept': 'text/event-stream' },
  })
  const reader = sseRes.body.getReader()
  const decoder = new TextDecoder()

  // 3. Push message
  console.log('3. Pushing message...')
  await fetch(`${API_BASE}/sessions/${session.id}/events`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${QODER_PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ events: [{ type: 'user.message', content: [{ type: 'text', text: 'What is 2+2? One word only.' }] }] }),
  })

  // 4. Stream
  console.log('4. Streaming...\n')
  const chunks = []
  let buffer = '', currentEvent = '', sawRunning = false
  const timeout = setTimeout(() => reader.cancel(), 30000)

  outer: while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n'); buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line.startsWith('event: ')) { currentEvent = line.slice(7).trim(); continue }
      if (!line.startsWith('data: ')) { if (line === '') currentEvent = ''; continue }
      try {
        const data = JSON.parse(line.slice(6))
        const et = currentEvent || data.type || ''
        if (et === 'session.status_running') { sawRunning = true; console.log('   [running]') }
        if (et === 'agent.message' && Array.isArray(data.content)) {
          for (const b of data.content) if (b.text) { chunks.push(b.text); console.log(`   [agent] "${b.text}"`) }
        }
        if (et === 'session.status_idle' && sawRunning) { console.log('   [idle] ✓'); break outer }
      } catch {}
    }
  }
  clearTimeout(timeout)
  console.log(`\n=== OUTPUT: "${chunks.join('')}" ===`)
}
main().catch(e => { console.error(e); process.exit(1) })
