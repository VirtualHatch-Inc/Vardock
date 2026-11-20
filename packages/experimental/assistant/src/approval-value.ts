/** Text of one model-supplied value on an owner approval card. */

/**
 * Characters that JSON leaves raw although they render as nothing, break a line, or change direction or format:
 * controls (Cc), format characters (Cf, including zero-width, bidirectional, and tag characters), line and paragraph
 * separators (Zl, Zp), and variation selectors.
 */
const UNSEEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu

/**
 * Render one value as a single JSON line in which every character the owner could not see appears as an escape.
 * @param value - Value exactly as the call supplied or the store holds it.
 * @returns JSON text of the value in which each {@link UNSEEN} character appears as its `\uXXXX` escapes, one per UTF-16 code unit.
 */
export function approvalValue(value: unknown): string {
  return JSON.stringify(value).replace(UNSEEN, char =>
    char.split('').map(unit => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''))
}
