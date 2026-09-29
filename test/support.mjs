import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
export const install = process.env.DSH_INSTALL ?? '/Users/maz/.local/share/deepseek-harness/0.2.0-rc.1-native-20260928'
const { DeepSeekHarness } = await import(pathToFileURL(join(install, 'packages/sdk/client/lib/index.js')))
export const model = 'loop-guard-test'
export const phrase = 'I should reconsider the previous conclusion because the missing premise needs verification before I can safely proceed with this difficult task. '
export const tool = (name, args, id = 'call') => ({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
export function ending(r) { return r.events.findLast(e => e.type === 'turn/end')?.data.reason.kind }
export async function fixture(t, respond, config = {}, extraPlugins = []) {
  const generated = [], counts = [], closed = [], timers = new Set()
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    const native = { version: 1, instance_id: 'loop-fixture', input_tokens: 1000, context_window: 150000,
      thinking_budget: 32768, thinking_closure_tokens: 4 }
    if (req.url.endsWith('/count_tokens')) {
      counts.push(body); res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ...native, model })); return
    }
    generated.push(body)
    const n = generated.length
    const result = respond(n, body)
    res.on('close', () => closed.push(n))
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const emit = data => res.write('data: ' + JSON.stringify({ id: `loop-${n}`, object: 'chat.completion.chunk', created: 1, model, ...data }) + '\n\n')
    const deltas = [...result.deltas ?? []]
    const finish = () => {
      emit({ choices: [{ index: 0, delta: {}, finish_reason: result.limit ? 'length' : result.tool ? 'tool_calls' : 'stop' }],
        ninfer: { ...native, cause: result.limit ? 'output_limit' : 'stop', tool_status: result.limit ? 'incomplete' : result.tool ? 'complete' : 'absent', effective_output_tokens: body.max_tokens } })
      emit({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 } })
      res.end('data: [DONE]\n\n')
    }
    if (result.slow) {
      const timer = setInterval(() => {
        if (deltas.length) emit({ choices: [{ index: 0, delta: deltas.shift(), finish_reason: null }] })
        else { clearInterval(timer); timers.delete(timer); if (!result.hang) finish() }
      }, 5)
      timers.add(timer)
      res.on('close', () => { clearInterval(timer); timers.delete(timer) })
    } else {
      for (const delta of deltas) emit({ choices: [{ index: 0, delta, finish_reason: null }] })
      if (!result.hang) finish()
    }
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const home = await mkdtemp(join(tmpdir(), 'dsh-loop-home-'))
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-loop-work-'))
  const profile = join(home, 'profiles/sdk')
  await mkdir(profile, { recursive: true })
  const packages = {
    'dsh-llm-ninfer': process.env.DSH_NINFER_PACKAGE ?? fileURLToPath(new URL('../../dsh-llm-ninfer/', import.meta.url)),
    'dsh-generation-recovery': process.env.DSH_RECOVERY_PACKAGE ?? fileURLToPath(new URL('../../dsh-generation-recovery/', import.meta.url)),
    'dsh-loop-guard': process.env.LOOP_GUARD_PACKAGE ?? resolve(fileURLToPath(new URL('..', import.meta.url))),
  }
  await mkdir(join(profile, 'node_modules'))
  for (const [name, dir] of Object.entries(packages)) await symlink(dir, join(profile, 'node_modules', name))
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'loop-test-sdk', private: true,
    dependencies: Object.fromEntries(Object.entries(packages).map(([name, dir]) => [name, 'link:' + dir])),
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app', ...Object.keys(packages)], patchReload: 'startup' } } }))
  await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify([
      { id: 'llm-ninfer', config: { provider: 'ninfer-local',
        baseURL: `http://127.0.0.1:${server.address().port}/v1`, credentialRef: 'LOOP_FIXTURE_KEY', models: [{ id: model, contextWindow: 150000 }] } },
      { id: 'generation-recovery', config: { providers: ['ninfer-local'] } },
      { id: 'loop-guard', config: { providers: ['ninfer-local'], ...config } },
      { insert: extraPlugins },
  ]))
  const harness = new DeepSeekHarness({ dshBin: join(install, 'apps/cli/lib/bin.js'), dshHome: home, cwd, profile: 'sdk',
    provider: 'ninfer-local', model, reasoningEffort: 'off', env: { ...process.env, LOOP_FIXTURE_KEY: 'fixture-only' } })
  t.after(async () => {
    await harness.close()
    for (const timer of timers) clearInterval(timer)
    server.closeAllConnections()
    await new Promise(r => server.close(r))
  })
  return { home, cwd, harness, generated, counts, closed }
}
