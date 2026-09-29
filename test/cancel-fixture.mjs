export const name = 'loop-guard-cancel-fixture'
export function apply(ctx) {
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (frame.type === 'chunk' && frame.chunk.type === 'reasoning-delta')
      agent.cancel({ kind: 'user' })
  })
}
