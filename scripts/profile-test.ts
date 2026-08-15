/** Regression test for persisted bundle enable/disable semantics. */

import assert from 'node:assert/strict'
import { reconcileBundleName, toggleBundleName } from '../src/host/bundle-state.ts'
import { mergeProfileDependency } from '../src/host/profile.ts'

assert.deepEqual(
  reconcileBundleName([], 'test-bundle', true, true, true, true),
  [],
  'an existing disabled bundle must remain disabled after update',
)
assert.deepEqual(
  reconcileBundleName([], 'another-bundle', false, false, true, true),
  ['another-bundle'],
  'a newly installed bundle must join the layer stack',
)
assert.deepEqual(
  reconcileBundleName([], 'late-bundle', true, false, true, true),
  ['late-bundle'],
  'an existing plain dependency that gains a bundle declaration must join the layer stack',
)
assert.deepEqual(toggleBundleName(['another-bundle'], 'test-bundle', true), ['another-bundle', 'test-bundle'])
assert.deepEqual(toggleBundleName(['another-bundle', 'test-bundle'], 'test-bundle', false), ['another-bundle'])
assert.deepEqual(toggleBundleName(['another-bundle'], 'another-bundle', true), ['another-bundle'])
assert.deepEqual(
  reconcileBundleName(['test-bundle'], 'test-bundle', true, true, false, false),
  [],
  'uninstalling a dependency must remove its bundle layer',
)

const latest = {
  name: 'profile',
  dependencies: { existing: '2.0.0', unrelated: '1.0.0' },
  dsh: { profile: { bundles: ['unrelated'] } },
}
assert.deepEqual(
  mergeProfileDependency(latest, 'target', 'file:../plugins/target'),
  {
    name: 'profile',
    dependencies: { existing: '2.0.0', unrelated: '1.0.0', target: 'file:../plugins/target' },
    dsh: { profile: { bundles: ['unrelated'] } },
  },
  'adding a dependency must preserve the latest unrelated dependencies and bundle choices',
)
assert.deepEqual(
  mergeProfileDependency(latest, 'existing', '1.0.0'),
  {
    name: 'profile',
    dependencies: { existing: '1.0.0', unrelated: '1.0.0' },
    dsh: { profile: { bundles: ['unrelated'] } },
  },
  'restoring a dependency must not replace the rest of the current manifest',
)

console.log('Profile bundle toggle tests passed')
