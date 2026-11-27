import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestExecArgv } from '../../vitest.shared.ts'

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] }), standardDecoratorPlugin()],
  test: {
    include: ['examples/practice/tests/*.spec.ts'],
    // Every practice test starts the inventory service on its fixed port.
    fileParallelism: false,
    execArgv: vitestExecArgv,
    pool: 'forks',
    testTimeout: 90_000,
    hookTimeout: 30_000,
  },
})
