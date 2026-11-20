/** Build benchmark artifacts without the TypeScript diagnostics that full builds own. */

import { buildLibraryArtifacts, runPnpmCommand } from './compile-referenced-projects.ts'

/**
 * Build native support, libraries, benchmark workers, and Web assets that benchmark files consume.
 * @param root - Repository root containing all build configurations.
 * @throws If any build fails.
 */
export function buildBenchArtifacts(root: string): void {
  runPnpmCommand(root, ['run', 'build:native-system'])
  buildLibraryArtifacts(root, false, 'benchmark-emit')
  runPnpmCommand(root, ['exec', 'tsdown', '--config-loader', 'native', '--config', 'benchmarks/tsdown.config.ts'])
  runPnpmCommand(root, ['run', 'build:web'])
}
