/** Validate the built typert manifest with the real loader validation.
 *  Run: node --experimental-strip-types scripts/typert-test.ts
 *  The loader is resolved through the normal module graph; when it is not
 *  available (e.g. a standalone checkout without a DSH install), the test
 *  skips instead of failing so CI without a full DSH tree stays green.
 */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { TYPERT } from '../lib/typert.js'

const require = createRequire(import.meta.url)
let loaderPath: string | null = null
if (process.env.TYPERT_LOADER !== undefined && process.env.TYPERT_LOADER.trim() !== '') {
  loaderPath = process.env.TYPERT_LOADER.trim()
} else {
  try {
    loaderPath = require.resolve('@deepseek-ai/dsh-typert-loader')
  } catch {
    loaderPath = null
  }
}

if (loaderPath === null) {
  console.log('[SKIP] @deepseek-ai/dsh-typert-loader is not resolvable from this checkout.')
  console.log('       Point NODE_PATH or TYPERT_LOADER at a DSH install to run the validation.')
  process.exit(0)
}

const mod = await import(pathToFileURL(loaderPath).href) as { validateTypertManifest?: (pkg: string, exported: unknown) => { invocations: unknown[]; package: string } }
if (typeof mod.validateTypertManifest !== 'function') {
  console.error('resolved typert-loader has no validateTypertManifest export: ' + loaderPath)
  process.exit(1)
}

const result = mod.validateTypertManifest('dsh-plugin-marketplace', TYPERT)
console.log('typert manifest valid: ' + String(result.invocations.length) + ' invocations, package ' + result.package)

const host = await import('../lib/index.js') as { default: { prototype: Record<string, unknown> } }
for (const invocation of result.invocations) {
  const descriptor = invocation as { method: string; implementation?: string }
  const implementation = descriptor.implementation ?? descriptor.method
  if (typeof host.default.prototype[implementation] !== 'function') {
    console.error('Remote method is not callable on MarketplaceService: ' + descriptor.method + ' -> ' + implementation)
    process.exit(1)
  }
}
console.log('typert host implementations callable: ' + String(result.invocations.length))

const expected = new Set([
  'search', 'details', 'guidedTask', 'installPlugin', 'manualInstall', 'update', 'uninstall',
  'setEnabled', 'jobStatus', 'installed', 'installLocation', 'setInstallDir',
  'diagnoseConflicts', 'restart',
])
const actual = new Set(result.invocations.map((invocation) => (invocation as { method: string }).method))
const missing = [...expected].filter(method => !actual.has(method))
if (missing.length > 0) {
  console.error('missing invocations: ' + missing.join(', '))
  process.exit(1)
}
console.log('typert manifest tests passed: 1')
