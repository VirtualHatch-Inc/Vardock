/** Durable coordinator phases, independent of external operation outcomes. */

/** Phase values retained in the Assistant work domain. */
export const workPhases = ['queued', 'running', 'completed', 'needs_input', 'failed', 'unknown', 'canceled'] as const

/** Durable coordinator phase, independent of external operation outcomes. */
export type WorkPhase = (typeof workPhases)[number]
