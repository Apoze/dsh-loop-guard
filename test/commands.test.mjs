import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

test('human controls are agent-local, idle-only and preserve off across a new user message', async () => {
  const listeners = new Map()
  let command
  const ctx = { on: (key, handler) => listeners.set(key, handler),
    inject: (_deps, callback) => callback({ commands: { register: value => { command = value } } }) }
  apply(ctx, { providers: ['ninfer-local'] })
  const agent = { status: 'idle' }, other = { status: 'idle' }
  const signal = new AbortController().signal
  const run = (a, rawInput) => command.handler({ agent: a, rawInput, signal })
  assert.match(run(agent, 'status').text, /activé/)
  assert.match(run(agent, 'off').text, /désactivé/)
  await listeners.get('agent/pre-step')({ agent, messages: [{ source: { kind: 'user' } }] }, async () => undefined)
  assert.match(run(agent, 'status').text, /désactivé/)
  assert.doesNotMatch(run(other, 'status').text, /désactivé/)
  agent.status = 'running'
  assert.equal(run(agent, 'on').kind, 'error')
  agent.status = 'idle'
  assert.match(run(agent, 'on').text, /activé/)
  assert.equal(run(agent, 'unknown').kind, 'error')
  assert.equal(run(agent, 'reset').kind, 'success')
})
