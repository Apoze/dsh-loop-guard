import { test } from 'node:test'
import assert from 'node:assert/strict'
import { configSchema } from '../lib/config.js'
import { TextDetector, toolCycle, digest, similar } from '../lib/detectors.js'
const settings = configSchema.parse({ providers: ['ninfer-local'] })
const phrase = 'I should reconsider the previous conclusion because the missing premise needs verification before I can safely proceed with this difficult task. '
test('streaming repeated reasoning is detected across arbitrary chunk boundaries', () => {
  const d = new TextDetector(settings, 'reasoning')
  let hit
  for (const c of phrase.repeat(6)) { hit = d.push(c); if (hit) break }
  assert.match(hit, /reasoning-verbatim/)
})
test('output detection checks final partial strides and ignores code fences', () => {
  const d = new TextDetector(settings, 'text')
  assert.equal(d.push('```text\n' + phrase.repeat(100) + '\n```\n'), undefined)
  assert.equal(d.finish(), undefined)
  const normal = new TextDetector(settings, 'text')
  assert.ok(normal.push(phrase.repeat(10)) ?? normal.finish())
})
test('paragraph recurrence catches numbered copies separated by other prose', () => {
  const d = new TextDetector(settings, 'reasoning')
  assert.match(d.push(`1. ${phrase}\n\nA new idea.\n\n2. ${phrase}\n\nAnother idea.\n\n3. ${phrase}\n\n`), /paragraph/)
})
test('distinct prose and two legitimate repetitions are preserved', () => {
  const d = new TextDetector(settings, 'text')
  assert.equal(d.push(phrase.repeat(2)), undefined)
  assert.equal(d.finish(), undefined)
})
test('canonical tool identities, bounded cycles, and progress', () => {
  assert.equal(digest({ a: 1, b: [2] }), digest({ b: [2], a: 1 }))
  assert.equal(toolCycle(['A', 'B', 'A', 'B', 'A'], 'B', settings), true)
  assert.equal(toolCycle(['A', 'B', 'A', 'C', 'A'], 'B', settings), false)
  assert.equal(toolCycle(['A'], 'A', settings), false)
})
test('word similarity requires enough evidence', () => {
  assert.equal(similar('yes', 'yes', 0.9), false)
  const text = phrase + 'Additional observations include cancellation transport parsing ordering budgets validation.'
  assert.equal(similar(text, text, 0.9), true)
})
test('invalid configurations fail at load', () => {
  for (const config of [{ providers: [] }, { providers: ['x'], stagnationSteps: 1 },
    { providers: ['x'], maxCycleLength: 32 }, { providers: ['x'], mystery: true }])
    assert.throws(() => configSchema.parse(config))
})
test('bounded streaming detector handles a megabyte without quadratic full-history scanning', () => {
  const d = new TextDetector(settings, 'reasoning')
  const start = performance.now()
  for (let i = 0; i < 10000; i++) {
    const hit = d.push(`Fact ${i.toString(36)} uses ${digest(i)} to identify the next distinct observation.\n`)
    assert.equal(hit, undefined)
  }
  assert.ok(performance.now() - start < 10000)
})
