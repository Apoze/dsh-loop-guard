/** Validated, deployment-owned thresholds. Zero disables optional detectors. */
import { z } from 'zod'

export const configSchema = z.object({
  providers: z.array(z.string().min(1)).min(1),
  maxRecoveriesPerTurn: z.number().int().min(0).max(10).default(2),
  maxToolBlocksPerTurn: z.number().int().min(1).max(20).default(3),
  thinkingMinChars: z.number().int().min(40).max(4000).default(120),
  outputMinChars: z.number().int().min(40).max(4000).default(200),
  textRepeats: z.number().int().min(2).max(6).default(3),
  maxTextWindow: z.number().int().min(1000).max(64000).default(16000),
  checkStride: z.number().int().min(1).max(1024).default(64),
  paragraphMinChars: z.number().int().min(40).max(1000).default(120),
  paragraphRepeats: z.number().int().min(2).max(10).default(3),
  stagnationSteps: z.number().int().min(0).max(10).default(4),
  stagnationMinChars: z.number().int().min(100).max(10000).default(600),
  similarity: z.number().min(0.8).max(1).default(0.92),
  toolCycleRepeats: z.number().int().min(2).max(6).default(3),
  maxCycleLength: z.number().int().min(1).max(32).default(8),
  toolHistorySize: z.number().int().min(24).max(512).default(64),
  evidenceHistorySize: z.number().int().min(32).max(4096).default(256),
  rereadWindow: z.number().int().min(0).max(100).default(12),
  rereadRatio: z.number().min(0.1).max(1).default(0.75),
  searchScopeLimit: z.number().int().min(0).max(100).default(8),
  fileReadLimit: z.number().int().min(0).max(500).default(0),
  exemptTools: z.array(z.string().min(1)).default(['job_wait', 'job_status', 'terminal_read', 'terminal_wait', 'sleep']),
  readTools: z.array(z.string().min(1)).default(['read']),
  searchTools: z.array(z.string().min(1)).default(['grep', 'glob']),
  mutationTools: z.array(z.string().min(1)).default(['write', 'edit', 'apply_patch']),
}).strict().superRefine((v, ctx) => {
  if (v.toolHistorySize < v.maxCycleLength * v.toolCycleRepeats)
    ctx.addIssue({ code: 'custom', message: 'toolHistorySize must hold maxCycleLength × toolCycleRepeats' })
  if (v.maxTextWindow < Math.max(v.thinkingMinChars, v.outputMinChars) * v.textRepeats)
    ctx.addIssue({ code: 'custom', message: 'maxTextWindow cannot hold the configured repetitions' })
  if (v.stagnationSteps === 1)
    ctx.addIssue({ code: 'custom', message: 'stagnationSteps must be 0 or at least 2' })
})

export type Config = z.input<typeof configSchema>
export type Settings = z.output<typeof configSchema>
