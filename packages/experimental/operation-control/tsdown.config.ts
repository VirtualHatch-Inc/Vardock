import { defineConfig } from 'tsdown'

/** Keep the authority, its Agent-side plugins, and its library independently loadable. */
export default defineConfig(({ env }) => ['index', 'agent', 'model-agent', 'handoff', 'library'].map(entry => ({
  entry: env?.DSH_BUILD_FACE === 'client' ? '' : [`lib/types/${entry}.js`],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  outputOptions: { inlineDynamicImports: true },
})))
