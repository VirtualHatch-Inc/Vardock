import { defineConfig } from 'tsdown'

/** Keep the HTTPS provider and the library loadable without the MCP provider's dependencies. */
export default defineConfig(({ env }) => ['index', 'mcp', 'library'].map(entry => ({
  entry: env?.DSH_BUILD_FACE === 'client' ? '' : [`lib/types/${entry}.js`],
  // The authority checks providers against the main entry's service class.
  external: entry === 'mcp' ? ['./index.js'] : [],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  outputOptions: { inlineDynamicImports: true },
})))
