/**
 * Default worker budget shared by repository gates, builds, linters, and Vitest configurations.
 *
 * The budget is the CPU count Node reports, capped at {@link LOCAL_PARALLELISM_CAP}, or
 * {@link LOCAL_TEST_PARALLELISM_CAP} for Vitest forks, because `os.availableParallelism()` reports host
 * CPUs rather than a container's CPU quota and runs share the workstation. Each tool's explicit override
 * (`DSH_GATE_CONCURRENCY`, `DSH_OXLINT_THREADS`, `DSH_COVERAGE_MAX_WORKERS`, `--maxWorkers`) still wins.
 */

import { availableParallelism } from 'node:os'

/** Largest default worker count. */
export const LOCAL_PARALLELISM_CAP = 12

/** Largest default Vitest fork count, for unit and coverage runs. */
export const LOCAL_TEST_PARALLELISM_CAP = 48

/**
 * Resolve the default worker budget for one process.
 * @param available - CPU count Node reports for this process.
 * @param cap - Cap; {@link LOCAL_TEST_PARALLELISM_CAP} for Vitest forks.
 * @returns `available` capped at `cap`.
 */
export function defaultParallelism(
  available: number = availableParallelism(),
  cap: number = LOCAL_PARALLELISM_CAP,
): number {
  return Math.min(available, cap)
}

/**
 * Describe a default worker budget for scheduler and tool start lines.
 * @param available - CPU count Node reports for this process.
 * @returns The budget and where it came from, for example `12 local default worker(s) of 256 CPU(s)`.
 */
export function describeDefaultParallelism(available: number = availableParallelism()): string {
  return `${String(defaultParallelism(available))} local default worker(s) of ${String(available)} CPU(s)`
}
