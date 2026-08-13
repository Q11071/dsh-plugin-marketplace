/** Validate the built artifacts against the real DSH loaders.
 *  node scripts/verify.mjs
 *  1. lib/typert.js must pass @deepseek-ai/dsh-typert-loader's manifest
 *     validation (bundled straight from the checkout source).
 *  2. lib/client.js must be a __ModuleLoader__ factory whose bare
 *     requires only name platform modules.
 */
import { createRequire } from 'node:module'
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const checkout = process.env.DSH_CHECKOUT ?? 'D:/DSH/deepseek-harness'
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

const PKG = 'dsh-plugin-marketplace'

// ── 1. typert manifest validation (the exact loader code path) ────────────
const manifestUrl = pathToFileURL(path.join(root, 'lib', 'typert.js')).href
const entry = `
import { validateTypertManifest } from '@deepseek-ai/dsh-typert-loader'
const mod = await import('${manifestUrl}')
const result = validateTypertManifest('${PKG}', mod.TYPERT)
console.log('typert manifest valid: ' + result.invocations.length + ' invocations, package ' + result.package)
`
const probePath = path.join(root, 'lib', 'verify.probe.mjs')
await esbuild.build({
  stdin: { contents: entry, resolveDir: path.join(checkout, 'packages', 'typert', 'loader', 'src'), sourcefile: 'verify-probe.ts' },
  bundle: true,
  external: [manifestUrl],
  platform: 'node',
  format: 'esm',
  target: 'es2024',
  outfile: probePath,
})
try {
  await import(pathToFileURL(probePath).href)
} finally {
  if (existsSync(probePath)) unlinkSync(probePath)
}

// ── 2. client bundle shape ────────────────────────────────────────────────
const client = readFileSync(path.join(root, 'lib', 'client.js'), 'utf8')
if (!client.startsWith('window.__ModuleLoader__.load({ id: "' + PKG + '"')) {
  throw new Error('client bundle banner mismatch')
}
const requires = [...client.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1])
const allowed = new Set([
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react', '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment', '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
])
for (const spec of requires) {
  if (!allowed.has(spec)) throw new Error('client bundle requires non-platform module: ' + spec)
}
console.log('client bundle shape valid: ' + requires.length + ' external require sites, all platform modules')

// ── 3. package manifest contract ──────────────────────────────────────────
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') throw new Error('dsh.bundle.patch missing')
if (pkg.dsh?.client?.platform !== 'web') throw new Error('dsh.client.platform must be web')
if (pkg.exports?.['./client'] === undefined) throw new Error('./client export missing')
if (pkg.exports?.['./typert'] === undefined) throw new Error('./typert export missing')
console.log('package manifest contract valid')

// Bundled central Registry contract.
const registry = JSON.parse(readFileSync(path.join(root, 'registry', 'plugins.json'), 'utf8'))
if (registry.schemaVersion !== 2 || Number.isNaN(Date.parse(registry.generatedAt)) || !Array.isArray(registry.plugins)) {
  throw new Error('bundled Registry root contract invalid')
}
const registryNames = new Set()
for (const plugin of registry.plugins) {
  if (plugin === null || typeof plugin !== 'object') throw new Error('Registry plugin row must be an object')
  const key = typeof plugin.fullName === 'string' ? plugin.fullName.toLowerCase() : ''
  if (!/^[\w.-]+\/[\w.-]+$/.test(key)) throw new Error('Registry fullName invalid')
  if (registryNames.has(key)) throw new Error('Registry repeats repository ' + plugin.fullName)
  registryNames.add(key)
  if (!/^[0-9a-f]{40}$/i.test(plugin.verifiedCommit ?? '')) throw new Error('Registry commit invalid: ' + plugin.fullName)
  if (typeof plugin.packageName !== 'string' || plugin.packageName === '') throw new Error('Registry packageName missing')
  if (typeof plugin.bundlePatch !== 'string' || plugin.bundlePatch === '') throw new Error('Registry bundlePatch missing')
  if (Number.isNaN(Date.parse(plugin.verifiedAt))) throw new Error('Registry verifiedAt invalid')
  if (plugin.install === null || typeof plugin.install !== 'object') throw new Error('Registry install metadata missing')
  if (!['automatic', 'guided'].includes(plugin.install.mode)) throw new Error('Registry install mode invalid')
  if (!Array.isArray(plugin.install.profiles)) throw new Error('Registry install profiles invalid')
  if (plugin.install.mode === 'automatic') {
    const expected = 'github:' + plugin.fullName + '#' + plugin.verifiedCommit
    if (plugin.install.source !== 'github' || plugin.install.spec.toLowerCase() !== expected.toLowerCase()) {
      throw new Error('automatic Registry install is not pinned to the verified GitHub commit: ' + plugin.fullName)
    }
  }
}
console.log('bundled Registry contract valid: ' + registry.plugins.length + ' verified plugins')

console.log('VERIFY OK')
