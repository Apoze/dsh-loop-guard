/** DSH integration: bounded recovery, durable notices and pre-dispatch refusal. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-commands'
import { configSchema, type Config } from './config.js'
import { digest, similar, TextDetector, toolCycle } from './detectors.js'
export type { Config } from './config.js'

declare module '@deepseek-ai/dsh-llm/types' {
  interface MessageSourceMap {
    'loop-guard': { kind: 'loop-guard'; form: 'notice'; summary: string }
  }
}

export const name = 'loop-guard'
export const inject = ['agents', 'llm', 'tools']
const LOOP_CODE = 'DSH_LOOP_DETECTED'

interface State {
  enabled: boolean
  recoveries: number
  blocks: number
  pending?: string
  reasoning: string[]
  lastRejected?: string
  tools: string[]
  reads: Map<string, number>
  readKeys: Set<string>
  rereads: boolean[]
  searches: Map<string, Set<string>>
  results: Set<string>
}

function fresh(): State {
  return { enabled: false, recoveries: 0, blocks: 0, reasoning: [], tools: [], reads: new Map(),
    readKeys: new Set(), rereads: [], searches: new Map(), results: new Set() }
}

function notice(reason: string, exhausted = false) {
  return createUserMessage({
    content: [{ type: 'text', text: exhausted
      ? `Loop guard stopped repeated non-progress (${reason}). The automatic recovery budget is exhausted. Completed tool actions remain valid; no tool from a rejected generation ran. A new user instruction can resume work.`
      : `Loop guard detected ${reason}. The looping generation was rejected; none of its tools ran. Completed earlier actions remain valid. Respect all original user constraints, especially restrictions on tools, files and output format. This notice grants no permission to create files or use tools. Change approach using existing results; do not repeat the rejected reasoning. If the requested repetition cannot be delivered under this guard, explain that limitation briefly instead of moving it to a file or claiming it was delivered. Do not claim work that has not been completed.` }],
    source: { kind: 'loop-guard', form: 'notice', summary: exhausted ? 'Loop guard: recovery exhausted' : `Loop guard: ${reason}` },
  })
}

/** Install only public DSH hooks; disposing the plugin removes every listener. */
export function apply(ctx: Context, config: Config): void {
  const s = configSchema.parse(config)
  const states = new WeakMap<Agent, State>()
  const requests = new WeakMap<GenerateOptions, State>()
  const disabled = new WeakSet<Agent>()
  function state(agent: Agent): State {
    let value = states.get(agent)
    if (!value) { value = fresh(); states.set(agent, value) }
    return value
  }
  function bounded<K, V>(map: Map<K, V>): void {
    while (map.size > s.evidenceHistorySize) map.delete(map.keys().next().value!)
  }
  function boundedSet<T>(set: Set<T>): void {
    while (set.size > s.evidenceHistorySize) set.delete(set.values().next().value!)
  }
  function fail(agent: Agent, reason: string): never {
    agent.session.append('user/message', notice(reason, true), { surfaceOp: 'append' })
    throw new LlmError('Loop guard: automatic recovery exhausted; new user input required', 'DSH_LOOP_EXHAUSTED')
  }

  ctx.on('agent/pre-step', ({ agent, messages }, next) => {
    if (messages.some(m => m.source.kind === 'user')) states.set(agent, fresh())
    return next()
  })

  ctx.on('agent/request-prepared', async ({ agent, request, signal }, next) => {
    signal.throwIfAborted()
    const st = state(agent)
    st.enabled = s.providers.includes(request.provider) && !disabled.has(agent)
    if (st.enabled) {
      if (st.blocks >= s.maxToolBlocksPerTurn) fail(agent, 'repeated blocked tool calls')
      requests.set(request, st)
    }
    return next()
  })

  ctx.on('llm/stream', (options, next) => {
    const st = requests.get(options)
    const downstream = next()
    if (!st || options.purpose) return downstream
    return guardStream(options, downstream, st)
  }, { prepend: true })

  async function* guardStream(options: GenerateOptions, downstream: AsyncIterable<StreamChunk>, st: State): AsyncGenerator<StreamChunk> {
    const detectors = new Map<number, TextDetector>()
    let reasoning = ''
    let detection: string | undefined
    for await (const chunk of downstream) {
      options.signal?.throwIfAborted()
      if (chunk.type === 'block-start' && (chunk.blockType === 'reasoning' || chunk.blockType === 'text'))
        detectors.set(chunk.index, new TextDetector(s, chunk.blockType))
      if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
        detection = detectors.get(chunk.index)?.push(chunk.text)
        if (chunk.type === 'reasoning-delta') reasoning = (reasoning + chunk.text).slice(-s.maxTextWindow)
      }
      if (chunk.type === 'block-end') {
        detection ??= detectors.get(chunk.index)?.finish()
        detectors.delete(chunk.index)
        if (chunk.block.type === 'reasoning' && reasoning.length >= s.stagnationMinChars) {
          if (st.lastRejected && similar(reasoning, st.lastRejected, s.similarity)) detection ??= 'rederived-reasoning'
          if (s.stagnationSteps > 1 && st.reasoning.length >= s.stagnationSteps - 1 &&
              st.reasoning.slice(-(s.stagnationSteps - 1)).every(old => similar(reasoning, old, s.similarity)))
            detection ??= 'cross-step-stagnation'
        }
      }
      // Preserve received bytes in the rejected attempt, including the offending delta.
      yield chunk
      if (detection) break
      if (chunk.type === 'finish' && chunk.reason.kind !== 'error' && chunk.reason.kind !== 'aborted') {
        if (reasoning.length >= s.stagnationMinChars) st.reasoning.push(reasoning)
        else st.reasoning = []
        st.reasoning = st.reasoning.slice(-Math.max(1, s.stagnationSteps))
      }
    }
    options.signal?.throwIfAborted()
    if (detection) {
      // Iterator close above must settle before a retry can open another request.
      st.pending = detection
      st.lastRejected = reasoning.length >= s.stagnationMinChars ? reasoning : undefined
      yield { type: 'finish', reason: { kind: 'error', failure: { code: LOOP_CODE, message: `Loop guard: ${detection}` } } }
    }
  }

  ctx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
    if (failure.code !== LOOP_CODE) return next()
    signal.throwIfAborted()
    const st = state(agent)
    if (!st.enabled || !st.pending) return next()
    const reason = st.pending
    st.pending = undefined
    if (st.recoveries >= s.maxRecoveriesPerTurn) fail(agent, reason)
    st.recoveries++
    agent.session.append('user/message', notice(reason), { surfaceOp: 'append' })
    return { kind: 'retry' }
  }, { prepend: true })

  function facts(exec: ToolExecution) {
    const args = exec.arguments !== null && typeof exec.arguments === 'object' && !Array.isArray(exec.arguments)
      ? exec.arguments as Record<string, unknown> : {}
    const path = args.file_path ?? args.path
    const pattern = args.pattern ?? args.query
    return { key: digest([exec.name, exec.arguments]), path: typeof path === 'string' ? path : undefined,
      pattern: typeof pattern === 'string' ? digest(pattern) : undefined }
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!exec.agent) return next()
    const st = state(exec.agent)
    if (!st.enabled) return next()
    exec.signal.throwIfAborted()
    const { key, path, pattern } = facts(exec)
    const exempt = s.exemptTools.includes(exec.name)
    let reason: string | undefined
    if (!exempt) {
      if (st.blocks >= s.maxToolBlocksPerTurn) reason = 'tool-block-budget-exhausted'
      else if (toolCycle(st.tools, key, s)) reason = 'repeated-tool-cycle'
      else if (s.readTools.includes(exec.name) && path) {
        if (s.fileReadLimit > 0 && (st.reads.get(path) ?? 0) >= s.fileReadLimit) reason = 'file-read-ceiling'
        const window = [...st.rereads, st.readKeys.has(key)].slice(-s.rereadWindow)
        if (s.rereadWindow > 0 && window.length === s.rereadWindow &&
            window.filter(Boolean).length / window.length >= s.rereadRatio) reason ??= 'redundant-same-range-reads'
      } else if (s.searchTools.includes(exec.name) && pattern && path && s.searchScopeLimit > 0) {
        const scopes = st.searches.get(pattern)
        if (scopes && !scopes.has(path) && scopes.size >= s.searchScopeLimit) reason = 'search-expansion-spiral'
      }
    }
    if (reason) {
      st.blocks++
      st.rereads = []
      st.lastRejected = st.reasoning.at(-1)
      return { kind: 'deny', reason: `Loop guard: ${reason}. This call did not run. Use existing results or change approach. Do not repeat this action unchanged.`,
        info: { name: 'LoopGuardError', code: 'DSH_LOOP_TOOL_BLOCKED', message: `Loop guard: ${reason}` } }
    }
    const decision = await next()
    if (decision.kind === 'allow') {
      st.tools.push(key)
      st.tools = st.tools.slice(-s.toolHistorySize)
    }
    return decision
  }, { prepend: true })

  // Results only count calls that reached the tool body; denied calls cannot inflate reads.
  ctx.on('tools/execute', async (exec, next) => {
    const result = await next()
    if (!exec.agent) return result
    const st = state(exec.agent)
    if (!st.enabled || result.isError) return result
    const { key, path, pattern } = facts(exec)
    if (s.mutationTools.includes(exec.name)) {
      st.readKeys.clear(); st.reads.clear(); st.rereads = []
      st.searches.clear(); st.reasoning = []; st.results.clear(); st.lastRejected = undefined
    } else {
      const resultKey = digest(result.content)
      if (!st.results.has(resultKey)) { st.reasoning = []; st.lastRejected = undefined }
      st.results.add(resultKey); boundedSet(st.results)
      if (s.readTools.includes(exec.name) && path) {
        st.reads.set(path, (st.reads.get(path) ?? 0) + 1); bounded(st.reads)
        st.rereads.push(st.readKeys.has(key)); st.rereads = st.rereads.slice(-Math.max(1, s.rereadWindow))
        st.readKeys.add(key); boundedSet(st.readKeys)
      }
      if (s.searchTools.includes(exec.name) && pattern && path) {
        const scopes = st.searches.get(pattern) ?? new Set<string>()
        scopes.add(path); boundedSet(scopes); st.searches.set(pattern, scopes); bounded(st.searches)
      }
    }
    return result
  })

  // Keep DSH's native reminder for unprotected providers, but avoid a second
  // reminder when this plugin has already supplied the denied tool result.
  ctx.on('tools/post-execute', async (_exec, result, next) => {
    const decision = await next()
    if (!result.isError || result.error.info?.code !== 'DSH_LOOP_TOOL_BLOCKED' || !decision.additionalContexts)
      return decision
    return { ...decision, additionalContexts: decision.additionalContexts.filter(m => String(m.source.kind) !== 'repeat-tool-reminder') }
  }, { prepend: true })

  ctx.inject(['commands'], commandCtx => {
    commandCtx.commands.register({
      name: 'loop-guard',
      description: 'Afficher ou régler la protection anti-boucle de cette conversation',
      input: { hint: '[status|reset|off|on]' },
      handler: ({ agent, rawInput, signal }) => {
        signal.throwIfAborted()
        const action = rawInput.trim() || 'status'
        if (!['status', 'reset', 'off', 'on'].includes(action))
          return { kind: 'error', text: 'Utilisation : /loop-guard status|reset|off|on' }
        if (action !== 'status' && agent.status !== 'idle')
          return { kind: 'error', text: 'Attendre la fin de la génération ou l’arrêter avant de modifier la protection.' }
        if (action === 'off') disabled.add(agent)
        if (action === 'on') disabled.delete(agent)
        if (action !== 'status') states.set(agent, fresh())
        const st = state(agent)
        return { kind: 'success', text: `Anti-boucle ${disabled.has(agent) ? 'désactivé' : 'activé'} pour les fournisseurs configurés. Reprises : ${st.recoveries}/${s.maxRecoveriesPerTurn} ; blocages : ${st.blocks}/${s.maxToolBlocksPerTurn}. Réglage local à cette conversation et à ce processus.` }
      },
    })
  })
}
