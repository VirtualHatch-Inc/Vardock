/** Remote input and human interaction policy for the single Assistant entrance. */
import type { Context } from '@deepseek-ai/cordis'
import type { RemoteAccessAction } from '@deepseek-ai/dsh-api-remote-access'
import type {} from '@deepseek-ai/dsh-user-approval'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import type { AssistantRuntime } from './index.ts'

const inspection: ReadonlySet<RemoteAccessAction> = new Set([
  'workspace/follow',
  'session/list', 'session/search', 'session/control', 'session/attachment',
  'session/page', 'session/events', 'session/observeEvent', 'session/observeProjections',
  'session/state', 'session/observeState', 'session/wait', 'session/follow', 'session/projections',
])

/**
 * Admit owner conversation input at the entrance and restrict inspection of work data.
 * @param ctx - owner of remote and interaction policy registrations.
 * @param runtime - durable entrance and worker identities.
 */
export function registerAssistantMediation(ctx: Context, runtime: Pick<AssistantRuntime, 'mainSessionId' | 'isOwnerOnlyDataSession'>): void {
  ctx.remoteAccess.guard((request) => {
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- other packages merge non-owner kinds into PrincipalMap.
    if (request.action.startsWith('assistant/')) return request.principal.kind === 'owner' ? undefined : 'assistant/owner-required'
    if (request.action === 'commands/execute' || request.action === 'session/fork') return 'assistant/entrance-required'
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- other packages merge non-owner kinds into PrincipalMap.
    if (request.principal.kind !== 'owner' && (request.action === 'session/attachment'
      || request.resources.some(resource => resource.kind === 'session' && runtime.isOwnerOnlyDataSession(resource.id)))) {
      return 'assistant/owner-required'
    }
    if (inspection.has(request.action)) return undefined
    for (const resource of request.resources) {
      if (resource.kind !== 'session') continue
      if (resource.id !== runtime.mainSessionId) return 'assistant/entrance-required'
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- other packages merge non-owner kinds into PrincipalMap.
      if (request.principal.kind !== 'owner') return 'assistant/owner-required'
    }
    if (request.action === 'session/updateQueue') {
      const args = request.args?.request
      const main = ctx.agents.get(runtime.mainSessionId)
      if (main === undefined || typeof args !== 'object' || args === null || !('itemId' in args)) return 'assistant/managed-input'
      const item = [...main.inbox.nextTurn, ...main.inbox.nextStep].find(message => message.id === args.itemId)
      if (item?.source.kind !== 'user') return 'assistant/managed-input'
    }
    return undefined
  })
  ctx.on('approval/request', (request, next) => {
    if (request.agent.id !== runtime.mainSessionId) return Promise.resolve('rejected')
    return next()
  }, { prepend: true })
  ctx.on('user-questions/request', (request, next) => {
    if (request.agent?.id !== runtime.mainSessionId) {
      return Promise.reject(new UserQuestionError('Return the question to the Assistant with report_work (needs_input).', 'ASK_CANCELLED'))
    }
    return next()
  }, { prepend: true })
}
