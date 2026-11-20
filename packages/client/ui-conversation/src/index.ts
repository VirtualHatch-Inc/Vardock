/** Browser conversation preferences. */
import type {} from '@deepseek-ai/dsh-settings'

import type { Volatile, Context } from '@deepseek-ai/cordis'
import type { BusyEnterBehavior } from './submission-settings.ts'
import z from '@deepseek-ai/schemastery'
import { ConversationAppearanceFields } from './appearance.ts'

import { ConversationSettingsFields } from './submission-settings.ts'

export {
  BUSY_ENTER_BEHAVIORS, BUSY_ENTER_FIELD, CONVERSATION_SETTINGS_NAMESPACE,
  DEFAULT_BUSY_ENTER_BEHAVIOR, type BusyEnterBehavior, type ConversationSettings,
} from './submission-settings.ts'

/** Runtime preferences projected to the browser. */
export interface Config {
  /** Enter key behavior while a turn is running. */
  busyEnter: Volatile<BusyEnterBehavior>
  /** Show the workspace chip and popup above the empty composer. */
  showWorkspacePicker: Volatile<boolean>
  /** Product name replacing the localized hero headline. */
  heroTitle?: Volatile<string>
  /** Show the preview badge beside the hero title. */
  showHeroBadge: Volatile<boolean>
  /** Use the plain localized message placeholder. */
  plainPlaceholder: Volatile<boolean>
}

/** Live preferences projected to the browser. */
export const Config = z.object({
  showWorkspacePicker: ConversationAppearanceFields.showWorkspacePicker.volatile(),
  heroTitle: ConversationAppearanceFields.heroTitle.volatile(),
  showHeroBadge: ConversationAppearanceFields.showHeroBadge.volatile(),
  plainPlaceholder: ConversationAppearanceFields.plainPlaceholder.volatile(),
  busyEnter: ConversationSettingsFields.busyEnter.volatile(),
})

/** Register browser conversation preferences.
 * @param ctx Plugin context used for optional settings presentation.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
}
