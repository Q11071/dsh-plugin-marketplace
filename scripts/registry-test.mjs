/** Regression tests for the static Registry validator. */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  InvalidCandidateError,
  encodeRawPath,
  safePatchPath,
  validateBundlePatch,
  validateManifest,
} from './registry-core.mjs'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

const identity = validateManifest(await readFile(path.join(root, 'package.json'), 'utf8'))
assert.equal(identity.packageName, 'dsh-plugin-marketplace')
assert.equal(identity.bundlePatch, './cordis.patch.yml')
assert.equal(identity.hasClient, true)
validateBundlePatch(await readFile(path.join(root, 'cordis.patch.yml'), 'utf8'), identity.packageName)

assert.equal(safePatchPath('./nested/plugin.yml'), true)
assert.equal(safePatchPath('../outside.yml'), false)
assert.equal(safePatchPath('C:/outside.yml'), false)
assert.equal(encodeRawPath('./nested/plugin.yml'), 'nested/plugin.yml')

assertInvalid(
  () => validateManifest('{"name":"bad","version":"1.0.0"}'),
  'manifest without dsh.bundle.patch',
)
assertInvalid(
  () => validateBundlePatch('- insert:\n    - id: wrong\n      name: another-package\n', identity.packageName),
  'patch without an owning loader entry',
)

globalThis.__DSH_REGISTRY_EXECUTED__ = false
validateBundlePatch(
  '- insert:\n'
  + '    - id: safe-static-data\n'
  + '      name: dsh-plugin-marketplace\n'
  + '      config: !!js globalThis.__DSH_REGISTRY_EXECUTED__ = true\n',
  identity.packageName,
)
assert.equal(globalThis.__DSH_REGISTRY_EXECUTED__, false, 'YAML !!js content must never execute during validation')
delete globalThis.__DSH_REGISTRY_EXECUTED__

console.log('Registry validator tests passed')

function assertInvalid(callback, label) {
  assert.throws(callback, error => error instanceof InvalidCandidateError, label)
}
