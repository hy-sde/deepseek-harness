import { defineConfig } from 'tsdown'

/**
 * Build the index and runner as separate single-entry bundles. The sibling
 * `runner.cjs` is loaded by file (spawned as a subprocess) and must be
 * CommonJS for a plain `node <file>` invocation; it needs no export entry
 * because nothing imports it. A multi-entry build emits an unlisted shared
 * chunk omitted by the package's exact `files` whitelist; separate builds
 * inline it.
 */
export default defineConfig([
  {
    entry: ['lib/types/index.js', 'lib/types/invariant.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: ['lib/types/runner.js'],
    outDir: 'lib',
    format: ['cjs'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
])
