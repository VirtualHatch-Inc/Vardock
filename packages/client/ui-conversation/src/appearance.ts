/** Profile appearance shared by Host validation and browser presentation. */
import z from '@deepseek-ai/schemastery'

/** Profile-selected composer and hero presentation. */
export interface ConversationAppearance {
  /** Show the workspace chip and its picker above the empty composer. */
  showWorkspacePicker?: boolean
  /** Product name replacing the localized hero headline. */
  heroTitle?: string
  /** Show the preview badge beside the hero title. */
  showHeroBadge?: boolean
  /** Use a plain localized placeholder in hero and ordinary composers. */
  plainPlaceholder?: boolean
}

/** Appearance fields shared by Host and browser configuration validation. */
export const ConversationAppearanceFields = {
  showWorkspacePicker: z.boolean().default(true),
  heroTitle: z.string(),
  showHeroBadge: z.boolean().default(true),
  plainPlaceholder: z.boolean().default(false),
}

/** Plain Host settings values and defaults used before the first mirror update. */
export const ConversationAppearanceSchema = z.object(ConversationAppearanceFields)
