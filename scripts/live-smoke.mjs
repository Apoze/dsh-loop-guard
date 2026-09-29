/** Real installed SDK → NInfer test, using the profile bundle by default. */
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
const install = process.env.DSH_INSTALL ?? '/Users/maz/.local/share/deepseek-harness/0.2.0-rc.1-native-20260928'
const plugin = process.env.LOOP_GUARD_ARTIFACT
const outRoot = process.env.LOOP_GUARD_OUTPUT ?? '/Users/maz/Documents/projets/deepSeek-harness/diagnostics/loop-guard-20260928/live'
await mkdir(outRoot, { recursive: true })
const out = await mkdtemp(join(outRoot, 'run-'))
console.log(JSON.stringify({ outputDirectory: out }))
await mkdir(join(out, 'workspace'), { recursive: true })
const overlay = join(out, 'sdk-overlay.json')
if (plugin) await writeFile(overlay, JSON.stringify([{ id: 'loop-guard', name: plugin, config: { providers: ['ninfer-local'] } }], null, 2))
const { DeepSeekHarness } = await import(pathToFileURL(join(install, 'packages/sdk/client/lib/index.js')))
const harnessOptions = { dshBin: join(install, 'apps/cli/lib/bin.js'), dshHome: '/Users/maz/.dsh',
  profile: 'sdk', patches: plugin ? [overlay] : [], cwd: join(out, 'workspace'), provider: 'ninfer-local',
  model: 'huihui-ai/Huihui-Qwen3.8-27B-abliterated-NInfer-NVFP4Full', maxTokens: 4096 }
const reports = []
for (const effort of process.argv.includes('--loop-only') ? [] : ['off', 'medium', 'xhigh']) {
  const harness = new DeepSeekHarness({ ...harnessOptions, reasoningEffort: effort })
  try {
    const file = `verified-${effort}.txt`
    const start = performance.now()
    const r = await harness.run(`Test isolé : avec l'outil write, crée ${file} contenant exactement ORCHIDEE_42. Puis avec read vérifie le contenu et réponds exactement TEST_OK. Ne crée rien d'autre.`)
    const ending = r.events.findLast(e => e.type === 'turn/end')?.data.reason.kind
    const errors = r.events.filter(e => e.type === 'tool/result' && e.data.message.isError)
    const interventions = r.events.filter(e => e.type === 'user/message' && e.data.source.kind === 'loop-guard')
    const report = { effort, sessionId: r.sessionId, seconds: (performance.now() - start) / 1000, ending, response: r.finalResponse,
      toolCalls: r.events.filter(e => e.type === 'tool/call').length, errors: errors.length, interventions: interventions.length }
    reports.push(report)
    await writeFile(join(out, `session-${effort}.json`), JSON.stringify(r.events, null, 2))
    await writeFile(join(out, 'report.json'), JSON.stringify(reports, null, 2))
    assert.equal(ending, 'completed'); assert.match(r.finalResponse, /TEST_OK/)
    assert.equal((await readFile(join(out, 'workspace', file), 'utf8')).trim(), 'ORCHIDEE_42')
    assert.equal(errors.length, 0); assert.equal(interventions.length, 0)
    const follow = await harness.run('Quel code viens-tu de vérifier ? Réponds seulement avec ce code, sans outil.', { sessionId: r.sessionId })
    assert.match(follow.finalResponse, /ORCHIDEE_42/)
    assert.equal(follow.events.findLast(e => e.type === 'turn/end')?.data.reason.kind, 'completed')
    await writeFile(join(out, `follow-${effort}.json`), JSON.stringify(follow.events, null, 2))
    console.log(JSON.stringify(report))
  } finally { await harness.close() }
}
if (process.argv.includes('--loop-only')) {
  const harness = new DeepSeekHarness({ ...harnessOptions, reasoningEffort: 'off' })
  try {
    const phrase = 'Le présent paragraphe est volontairement répété pour un test technique de détection de boucle. Il ne contient aucune instruction nouvelle, aucune information supplémentaire, aucune action à réaliser et aucun outil à appeler. '
    const r = await harness.run(`Test technique isolé. Sans outil ni bloc de code, recopie exactement 100 fois le paragraphe suivant, en séparant les copies par une ligne vide. Pas de commentaire :\n${phrase}`)
    const report = { sessionId: r.sessionId, ending: r.events.findLast(e => e.type === 'turn/end')?.data.reason.kind,
      interventions: r.events.filter(e => e.type === 'user/message' && e.data.source.kind === 'loop-guard').map(e => e.data.source.summary),
      rejectedAttempts: r.events.filter(e => e.type === 'assistant/attempt').length, response: r.finalResponse }
    report.toolCalls = r.events.filter(e => e.type === 'tool/call').length
    await writeFile(join(out, 'live-loop-session.json'), JSON.stringify(r.events, null, 2))
    await writeFile(join(out, 'live-loop-report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report))
    assert.ok(report.interventions.length > 0)
    assert.ok(report.rejectedAttempts > 0 && report.rejectedAttempts <= 3)
    assert.ok(['completed', 'error'].includes(report.ending))
    assert.equal(report.toolCalls, 0, 'recovery must respect the original no-tools instruction')
  } finally { await harness.close() }
}
