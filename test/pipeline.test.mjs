import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixture, ending, phrase, tool } from './support.mjs'

test('user cancellation wins over recovery and closes the live HTTP stream', { timeout: 30000 }, async t => {
  const f = await fixture(t, () => ({ slow: true, hang: true, deltas: Array.from({ length: 30 }, () => ({ reasoning_content: phrase })) }), {},
    [{ id: 'cancel-fixture', name: fileURLToPath(new URL('./cancel-fixture.mjs', import.meta.url)) }])
  const r = await f.harness.run('Start thinking.')
  assert.equal(ending(r), 'aborted')
  assert.equal(f.generated.length, 1)
  assert.ok(f.closed.includes(1))
  assert.equal(r.events.filter(e => e.type === 'user/message' && e.data.source.kind === 'loop-guard').length, 0)
})

test('a protected provider not selected leaves the native reminder available', { timeout: 30000 }, async t => {
  const f = await fixture(t, n => n <= 3 ? { tool: true, deltas: [tool('read', { file_path: 'a.txt' }, `r-${n}`)] }
    : { deltas: [{ content: 'OTHER_PROVIDER_OK' }] }, { providers: ['other-provider'] })
  await writeFile(join(f.cwd, 'a.txt'), 'native reminder')
  const r = await f.harness.run('Read a.txt.')
  assert.equal(ending(r), 'completed')
  assert.equal(r.events.filter(e => e.type === 'tool/result' && e.data.message.isError).length, 0)
  assert.equal(r.events.filter(e => e.type === 'user/message' && e.data.source.kind === 'repeat-tool-reminder').length, 1)
})

test('real installed DSH rejects a looping stream, closes transport and retries without polluted context', { timeout: 30000 }, async t => {
  const f = await fixture(t, n => n === 1
    ? { slow: true, hang: true, deltas: Array.from({ length: 30 }, () => ({ reasoning_content: phrase })) }
    : { deltas: [{ content: 'RECOVERED' }] })
  const result = await f.harness.run('Answer concisely without tools.')
  assert.equal(ending(result), 'completed')
  assert.match(result.finalResponse, /RECOVERED/)
  assert.equal(f.generated.length, 2)
  assert.ok(f.closed.includes(1))
  assert.equal(result.events.filter(e => e.type === 'assistant/attempt').length, 1)
  assert.ok(result.events.some(e => e.type === 'user/message' && e.data.source.kind === 'loop-guard'))
  assert.ok(!JSON.stringify(f.generated[1].messages).includes(phrase.trim()))
  assert.deepEqual(f.counts[1].messages, f.generated[1].messages)
  const projected = result.events.flatMap(e => {
    if (e.type === 'assistant/attempt') return [{ type: e.type, finish: e.data.stream.findLast(x => x.type === 'chunk' && x.chunk.type === 'finish')?.chunk.reason.failure?.code }]
    if (e.type === 'user/message' && e.data.source.kind === 'loop-guard') return [{ type: e.type, source: e.data.source, content: e.data.content }]
    if (e.type === 'assistant/message') return [{ type: e.type, content: e.data.message.content }]
    return []
  })
  assert.deepEqual(projected, JSON.parse(await readFile(new URL('./expected/recovered-session.json', import.meta.url), 'utf8')))
  const output = new URL('../test-output/', import.meta.url)
  await mkdir(output, { recursive: true })
  await writeFile(new URL('recorded-session.json', output), JSON.stringify(result.events, null, 2))
})
test('visible output loops also reject the whole generation', { timeout: 30000 }, async t => {
  const f = await fixture(t, n => ({ deltas: [{ content: n === 1 ? phrase.repeat(12) : 'OUTPUT_RECOVERED' }] }))
  const r = await f.harness.run('Answer.')
  assert.equal(ending(r), 'completed')
  assert.equal(f.generated.length, 2)
  assert.ok(!JSON.stringify(f.generated[1].messages).includes(phrase.trim()))
})
test('repeated streaming failures exhaust their own budget, not generation-recovery', { timeout: 30000 }, async t => {
  const f = await fixture(t, () => ({ deltas: [{ reasoning_content: phrase.repeat(8) }] }))
  const r = await f.harness.run('Answer.')
  assert.equal(ending(r), 'error')
  assert.equal(f.generated.length, 3)
  assert.equal(r.events.filter(e => e.type === 'agent/generation-recovery').length, 0)
  assert.equal(r.events.filter(e => e.type === 'assistant/attempt').length, 3)
})
test('truncation recovery and loop recovery coexist', { timeout: 30000 }, async t => {
  const f = await fixture(t, n => n === 1 ? { limit: true } : n === 2
    ? { deltas: [{ reasoning_content: phrase.repeat(8) }] } : { deltas: [{ content: 'BOTH_RECOVERED' }] })
  const r = await f.harness.run('Answer.')
  assert.equal(ending(r), 'completed')
  assert.equal(f.generated.length, 3)
  assert.equal(r.events.filter(e => e.type === 'agent/generation-recovery').length, 1)
})
test('third identical tool is denied before dispatch and a new action remains possible', { timeout: 30000 }, async t => {
  const f = await fixture(t, n => n <= 3 ? { tool: true, deltas: [tool('read', { file_path: 'a.txt' }, `read-${n}`)] }
    : { deltas: [{ content: 'READ_DONE' }] })
  await writeFile(join(f.cwd, 'a.txt'), 'unchanged evidence')
  const r = await f.harness.run('Read a.txt and answer.')
  assert.equal(ending(r), 'completed')
  const results = r.events.filter(e => e.type === 'tool/result')
  assert.equal(results.length, 3)
  assert.equal(results.filter(e => e.data.message.isError).length, 1)
  assert.match(JSON.stringify(results.at(-1)), /DSH_LOOP_TOOL_BLOCKED/)
  assert.equal(r.events.filter(e => e.type === 'user/message' && e.data.source.kind === 'repeat-tool-reminder').length, 0)
})

test('new user input resets budgets on the same session and other sessions stay independent', { timeout: 30000 }, async t => {
  let phase = 'loop'
  const f = await fixture(t, () => ({ deltas: [{ content: phase === 'loop' ? phrase.repeat(12) : 'NEW_TURN_OK' }] }), { maxRecoveriesPerTurn: 0 })
  const first = await f.harness.run('Answer.')
  assert.equal(ending(first), 'error')
  phase = 'normal'
  const resumed = await f.harness.run('Use a new approach.', { sessionId: first.sessionId })
  assert.equal(ending(resumed), 'completed')
  const separate = await f.harness.run('A different session.')
  assert.equal(ending(separate), 'completed')
  assert.notEqual(separate.sessionId, first.sessionId)
})

test('read edit read sequence remains valid and preserves the real file', { timeout: 30000 }, async t => {
  const actions = [tool('read', { file_path: 'a.txt' }, 'r1'),
    tool('edit', { file_path: 'a.txt', old_string: 'before', new_string: 'after' }, 'e1'),
    tool('read', { file_path: 'a.txt' }, 'r2')]
  const f = await fixture(t, n => n <= actions.length ? { tool: true, deltas: [actions[n - 1]] } : { deltas: [{ content: 'EDIT_OK' }] })
  await writeFile(join(f.cwd, 'a.txt'), 'before')
  const r = await f.harness.run('Update a.txt then verify.')
  assert.equal(ending(r), 'completed')
  assert.equal(await readFile(join(f.cwd, 'a.txt'), 'utf8'), 'after')
  assert.equal(r.events.filter(e => e.type === 'tool/result' && e.data.message.isError).length, 0)
})

test('tool exemptions allow intentional repeated reads', { timeout: 30000 }, async t => {
  const f = await fixture(t, n => n <= 5 ? { tool: true, deltas: [tool('read', { file_path: 'a.txt' }, `read-${n}`)] }
    : { deltas: [{ content: 'EXEMPT_OK' }] }, { exemptTools: ['read'] })
  await writeFile(join(f.cwd, 'a.txt'), 'polling fixture')
  const r = await f.harness.run('Read repeatedly.')
  assert.equal(ending(r), 'completed')
  assert.equal(r.events.filter(e => e.type === 'tool/result' && e.data.message.isError).length, 0)
})

test('interleaved same-range rereads trigger the bounded reread detector', { timeout: 30000 }, async t => {
  const paths = ['a', 'b', 'c', 'a', 'd', 'b']
  const f = await fixture(t, n => n <= paths.length ? { tool: true, deltas: [tool('read', { file_path: paths[n - 1] }, `r-${n}`)] }
    : { deltas: [{ content: 'REREAD_OK' }] }, { rereadWindow: 6, rereadRatio: 0.3 })
  for (const path of new Set(paths)) await writeFile(join(f.cwd, path), path)
  const r = await f.harness.run('Inspect the files.')
  assert.equal(ending(r), 'completed')
  const blocked = r.events.filter(e => e.type === 'tool/result' && e.data.error?.code === 'DSH_LOOP_TOOL_BLOCKED')
  assert.equal(blocked.length, 1)
  assert.match(JSON.stringify(blocked[0]), /redundant-same-range/)
})

test('cross-step stagnation rejects the next tool batch without erasing completed actions', { timeout: 30000 }, async t => {
  const thought = Array.from({ length: 80 }, (_, i) => `Observation${i} requires verification of premise${i}.`).join(' ')
  const f = await fixture(t, n => n <= 6 ? { tool: true, deltas: [{ reasoning_content: thought },
    tool('read', { file_path: 'same.txt' }, `r-${n}`)] } : { deltas: [{ content: 'STAGNATION_RECOVERED' }] }, { exemptTools: ['read'] })
  await writeFile(join(f.cwd, 'same.txt'), 'same result')
  const r = await f.harness.run('Inspect files and do not repeat reasoning.')
  assert.ok(r.events.some(e => e.type === 'assistant/attempt'))
  assert.ok(r.events.some(e => e.type === 'user/message' && e.data.source.kind === 'loop-guard'))
  assert.ok(r.events.some(e => e.type === 'user/message' && JSON.stringify(e.data).includes('cross-step-stagnation')))
  assert.equal(ending(r), 'completed')
})
test('ABABAB cycles are blocked; perpetual tool denial has a finite request count', { timeout: 30000 }, async t => {
  const f = await fixture(t, n => ({ tool: true, deltas: [tool('read', { file_path: n % 2 ? 'a.txt' : 'b.txt' }, `read-${n}`)] }))
  await writeFile(join(f.cwd, 'a.txt'), 'A'); await writeFile(join(f.cwd, 'b.txt'), 'B')
  const r = await f.harness.run('Inspect both files.')
  assert.equal(ending(r), 'error')
  assert.ok(f.generated.length < 20)
  assert.equal(r.events.filter(e => e.type === 'tool/result' && e.data.message.isError).length, 3)
})
test('different read ranges are not redundant reads', { timeout: 30000 }, async t => {
  const f = await fixture(t, n => n <= 8 ? { tool: true, deltas: [tool('read', { file_path: 'a.txt', offset: n, limit: 1 }, `read-${n}`)] }
    : { deltas: [{ content: 'PAGES_DONE' }] }, { rereadWindow: 4, rereadRatio: 0.5 })
  await writeFile(join(f.cwd, 'a.txt'), Array.from({ length: 20 }, (_, i) => `Line ${i}`).join('\n'))
  const r = await f.harness.run('Inspect file pages.')
  assert.equal(ending(r), 'completed')
  assert.equal(r.events.filter(e => e.type === 'tool/result' && e.data.message.isError).length, 0)
})
test('rejected generation cannot execute the write it contains', { timeout: 30000 }, async t => {
  const f = await fixture(t, n => n === 1 ? { tool: true, deltas: [tool('write', { file_path: 'never.txt', content: 'bad' }), { reasoning_content: phrase.repeat(8) }] }
    : { deltas: [{ content: 'SAFE' }] })
  const r = await f.harness.run('Answer.')
  assert.equal(ending(r), 'completed')
  await assert.rejects(readFile(join(f.cwd, 'never.txt')), { code: 'ENOENT' })
  assert.equal(r.events.filter(e => e.type === 'tool/call').length, 0)
})

test('parallel repeated tool batch denies only the repeated call and settles every result', { timeout: 30000 }, async t => {
  const calls = [0, 1, 2].map(index => ({ ...tool('read', { file_path: 'a.txt' }, `parallel-${index}`).tool_calls[0], index }))
  const f = await fixture(t, n => n === 1 ? { tool: true, deltas: [{ tool_calls: calls }] } : { deltas: [{ content: 'BATCH_OK' }] })
  await writeFile(join(f.cwd, 'a.txt'), 'parallel fixture')
  const r = await f.harness.run('Inspect a.txt.')
  assert.equal(ending(r), 'completed')
  const results = r.events.filter(e => e.type === 'tool/result')
  assert.equal(results.length, 3)
  assert.equal(results.filter(e => e.data.error?.code === 'DSH_LOOP_TOOL_BLOCKED').length, 1)
})

test('optional file ceiling counts actual reads across distinct ranges', { timeout: 30000 }, async t => {
  const f = await fixture(t, n => n <= 3 ? { tool: true, deltas: [tool('read', { file_path: 'a.txt', offset: n, limit: 1 }, `ceiling-${n}`)] }
    : { deltas: [{ content: 'CEILING_OK' }] }, { fileReadLimit: 2 })
  await writeFile(join(f.cwd, 'a.txt'), 'one\ntwo\nthree\nfour')
  const r = await f.harness.run('Read pages.')
  assert.equal(ending(r), 'completed')
  const blocked = r.events.filter(e => e.type === 'tool/result' && e.data.error?.code === 'DSH_LOOP_TOOL_BLOCKED')
  assert.equal(blocked.length, 1)
  assert.match(JSON.stringify(blocked), /file-read-ceiling/)
})

test('configured search expansion limit blocks before the next scope is searched', { timeout: 30000 }, async t => {
  const f = await fixture(t, n => n <= 3 ? { tool: true, deltas: [tool('grep', { pattern: 'needle', path: `d${n}` }, `s-${n}`)] }
    : { deltas: [{ content: 'SEARCH_OK' }] }, { searchScopeLimit: 2 })
  for (let n = 1; n <= 3; n++) { await mkdir(join(f.cwd, `d${n}`)); await writeFile(join(f.cwd, `d${n}/a.txt`), 'needle') }
  const r = await f.harness.run('Search for needle.')
  assert.equal(ending(r), 'completed')
  const blocked = r.events.filter(e => e.type === 'tool/result' && e.data.error?.code === 'DSH_LOOP_TOOL_BLOCKED')
  assert.equal(blocked.length, 1)
  assert.match(JSON.stringify(blocked), /search-expansion-spiral/)
})
