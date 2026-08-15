/** Run the plugin TypeScript check against a selected DSH checkout.
 *
 * The development tsconfig intentionally points at the maintainer's DSH
 * checkout. CI rewrites only that checkout prefix into a temporary config,
 * preserving the exact module/type map used by local builds.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceConfig = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8'))
const configuredCheckout = process.env.DSH_CHECKOUT?.trim() || 'D:/DSH/deepseek-harness'
const checkout = resolve(configuredCheckout)
const baseConfig = join(checkout, 'tsconfig.base.json')
if (!existsSync(baseConfig)) throw new Error('DSH checkout is missing tsconfig.base.json: ' + checkout)

const originalBase = sourceConfig.extends.replace(/\\/g, '/').replace(/\/[^/]+$/, '')
const checkoutPosix = checkout.replace(/\\/g, '/')
sourceConfig.extends = baseConfig.replace(/\\/g, '/')
for (const [name, targets] of Object.entries(sourceConfig.compilerOptions?.paths ?? {})) {
  sourceConfig.compilerOptions.paths[name] = targets.map((target) => {
    const normalized = target.replace(/\\/g, '/')
    if (!normalized.startsWith(originalBase + '/')) {
      throw new Error('TypeScript path is outside the configured DSH checkout: ' + target)
    }
    return checkoutPosix + normalized.slice(originalBase.length)
  })
}

const temporaryConfig = join(root, '.tsconfig.typecheck-' + process.pid + '.json')
writeFileSync(temporaryConfig, JSON.stringify(sourceConfig, null, 2) + '\n', 'utf8')
try {
  const tsc = require.resolve('typescript/bin/tsc')
  const result = spawnSync(process.execPath, [tsc, '--noEmit', '-p', temporaryConfig], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.error !== undefined) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  unlinkSync(temporaryConfig)
}
