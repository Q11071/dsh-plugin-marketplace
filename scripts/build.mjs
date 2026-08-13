/** Build the dual-face plugin artifacts with the checkout's esbuild.
 *  node scripts/build.mjs  (DSH_CHECKOUT overrides the checkout path)
 *  Emits: lib/index.js (host), lib/typert.js, lib/remote.js, lib/client.js
 */
import { createRequire } from 'node:module'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const checkout = process.env.DSH_CHECKOUT ?? 'D:/DSH/deepseek-harness'
/** Resolve one package under the checkout's pnpm store (newest wins). */
function resolvePnpmPackage(checkout, name) {
  const pnpmDir = path.join(checkout, 'node_modules', '.pnpm')
  const candidates = readdirSync(pnpmDir).filter((entry) => entry.startsWith(name + '@')).sort().reverse()
  for (const entry of candidates) {
    const pkg = path.join(pnpmDir, entry, 'node_modules', name)
    if (existsSync(path.join(pkg, 'package.json'))) return pkg
  }
  throw new Error(name + ' not found under ' + pnpmDir)
}

/** Resolve esbuild from the checkout's pnpm store (newest version wins). */
function resolveEsbuild(checkout) {
  const pnpmDir = path.join(checkout, 'node_modules', '.pnpm')
  const candidates = readdirSync(pnpmDir).filter((name) => name.startsWith('esbuild@')).sort().reverse()
  for (const name of candidates) {
    const main = path.join(pnpmDir, name, 'node_modules', 'esbuild', 'lib', 'main.js')
    if (existsSync(main)) return main
  }
  throw new Error('esbuild not found under ' + pnpmDir)
}

const esbuild = require(resolveEsbuild(checkout))

// The loader module table: every entry the browser require can answer
// (platform seed + the documented runtime-store exemption).
const PLATFORM_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

const ID = 'dsh-plugin-marketplace'
const INTRO = 'var module = { exports: {} }; var exports = module.exports;'
const BANNER = 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(ID) + ', factory: (require) => {\n' + INTRO
const FOOTER = 'return module.exports; } });'

await esbuild.build({
  absWorkingDir: root,
  entryPoints: ['src/host/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'es2024',
  outfile: 'lib/index.js',
  external: ['@deepseek-ai/*', 'zod'],
  logLevel: 'info',
  nodePaths: [path.join(checkout, 'node_modules')],
})

await esbuild.build({
  absWorkingDir: root,
  entryPoints: ['src/typert.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'es2024',
  outfile: 'lib/typert.js',
  alias: { zod: resolvePnpmPackage(checkout, 'zod') },
})

await esbuild.build({
  absWorkingDir: root,
  entryPoints: ['src/remote.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'es2024',
  outfile: 'lib/remote.js',
  alias: { zod: resolvePnpmPackage(checkout, 'zod') },
})

await esbuild.build({
  absWorkingDir: root,
  entryPoints: ['src/client/index.ts'],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  jsx: 'automatic',
  outfile: 'lib/client.js',
  external: PLATFORM_EXTERNALS,
  alias: { zod: resolvePnpmPackage(checkout, 'zod') },
  banner: { js: BANNER },
  footer: { js: FOOTER },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
})

console.log('build complete: lib/index.js, lib/typert.js, lib/remote.js, lib/client.js')