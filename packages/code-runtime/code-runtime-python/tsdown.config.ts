import { defineConfig } from 'tsdown'

/**
 * Single-entry host bundle plus the package-owned invariant companion. The
 * Python runner needs no bundle entry: it leaves the process through a
 * subprocess as a staged script, not through the package files.
 */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/invariant.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
