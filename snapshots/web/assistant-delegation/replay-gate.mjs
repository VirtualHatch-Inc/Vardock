/** Keep result admission after the main Session's acknowledgement turn. */
export const inject = ['agents']

export function apply(ctx, { mainSessionId }) {
  const settled = Promise.withResolvers()
  ctx.on('session/event', (session, event) => {
    if (session.id === mainSessionId && event.type === 'turn/end' && event.data.turn === 1) settled.resolve()
  })
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    if (agent.id.startsWith('assistant-work-')) {
      const abort = Promise.withResolvers()
      const cancel = () => abort.reject(signal.reason)
      signal.throwIfAborted()
      signal.addEventListener('abort', cancel, { once: true })
      try {
        await Promise.race([settled.promise, abort.promise])
      } finally {
        signal.removeEventListener('abort', cancel)
      }
    }
    return next()
  })
}
