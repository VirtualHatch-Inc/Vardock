/** Profile preferences for Agent-preset presentation. */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

/** Browser presentation preferences. */
export interface Config {
  /** Show the hero preset selector and Session header preset label. */
  showConversationControls: Volatile<boolean>
}

/** Validate profile presentation preferences. */
export const Config = z.object({ showConversationControls: z.boolean().default(true).volatile() })

/** Load browser preferences.
 * @param _ctx - plugin context.
 */
export function apply(_ctx: Context): void {
  _ctx.inject(['settings'], (scope) => { scope.effect(() => scope.settings.configure({ auto: false }, _ctx.fiber)) })
}
