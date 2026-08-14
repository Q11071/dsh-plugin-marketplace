/** Regression test for persisted bundle enable/disable semantics. */

import assert from 'node:assert/strict'
import { reconcileBundleNames, toggleBundleName } from '../src/host/bundle-state.ts'

const bundles = new Set(['test-bundle', 'another-bundle'])
assert.deepEqual(
  reconcileBundleNames(['test-bundle'], ['test-bundle', 'another-bundle'], [], name => bundles.has(name)),
  ['another-bundle'],
  'installing another bundle must not re-enable an existing disabled bundle',
)
assert.deepEqual(toggleBundleName(['another-bundle'], 'test-bundle', true), ['another-bundle', 'test-bundle'])
assert.deepEqual(toggleBundleName(['another-bundle', 'test-bundle'], 'test-bundle', false), ['another-bundle'])
assert.deepEqual(toggleBundleName(['another-bundle'], 'another-bundle', true), ['another-bundle'])
assert.deepEqual(
  reconcileBundleNames(['test-bundle'], [], ['test-bundle'], name => bundles.has(name)),
  [],
  'uninstalling a dependency must remove its bundle layer',
)

console.log('Profile bundle toggle tests passed')
