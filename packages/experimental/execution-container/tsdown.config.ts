import { defineConfig } from 'tsdown'

/** Keep the authority's execution library loadable without the execution backends. */
export default defineConfig(({ env }) => ['index', 'library'].map(entry => ({
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
