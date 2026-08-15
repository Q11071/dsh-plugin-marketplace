/** Regression tests for the non-shell manual install command parser. */

import assert from 'node:assert/strict'
import { parseManualInstall } from '../src/host/manual-install.ts'

assert.deepEqual(parseManualInstall('github:owner/plugin', 'web'), { repo: 'owner/plugin', ref: '' })
assert.deepEqual(
  parseManualInstall('dsh plugin --profile web add github:owner/plugin#v1.2.3', 'web'),
  { repo: 'owner/plugin', ref: 'v1.2.3' },
)
assert.deepEqual(
  parseManualInstall('`dsh plugin --profile=web add github:owner/plugin#feature/safe-ref`', 'web'),
  { repo: 'owner/plugin', ref: 'feature/safe-ref' },
)
assert.throws(
  () => parseManualInstall('dsh plugin --profile headless add github:owner/plugin', 'web'),
  /must match the current Profile/,
)
assert.throws(() => parseManualInstall('dsh plugin --profile web add npm-package', 'web'), /Only a GitHub source/)
assert.throws(() => parseManualInstall('github:owner/plugin#main && whoami', 'web'), /Only `dsh plugin|GitHub ref/)
assert.throws(() => parseManualInstall('github:owner/plugin#feature/../main', 'web'), /unsupported/)
assert.throws(() => parseManualInstall('github:owner/plugin\nwhoami', 'web'), /single line/)

console.log('Manual install command parser tests passed')
