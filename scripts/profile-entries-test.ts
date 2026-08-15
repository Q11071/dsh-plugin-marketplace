/** Unit tests for installed-entry summaries and the unlinked-directory scan.
 *  Run: node --experimental-strip-types scripts/profile-entries-test.ts
 *  Covers PR notes §14 item 10 and the unlinked-dir listing behavior (§6.5).
 */

import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProfileManifest } from '@deepseek-ai/dsh-app-boot'
import { installedEntries, installedPackageSummary } from '../src/host/profile.ts'

let passed = 0
function ok(name: string, fn: () => void): void {
  fn()
  passed += 1
  console.log('ok - ' + name)
}

function makeBundle(dir: string, name: string, extra: Record<string, unknown> = {}): void {
  const target = join(dir, 'node_modules', ...name.split('/'))
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'package.json'), JSON.stringify({
    name,
    version: '1.2.3',
    description: name + ' does things',
    homepage: 'https://github.com/owner/' + name,
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    ...extra,
  }))
  writeFileSync(join(target, 'cordis.patch.yml'), '- insert:\n    - id: ' + name + '\n      name: ' + name + '\n')
}

const tmp = mkdtempSync(join(tmpdir(), 'mkt-entries-test-'))
try {
  // ── installedPackageSummary ───────────────────────────────────────────
  const profileDir = join(tmp, 'profile')
  makeBundle(profileDir, 'linked-plugin')
  ok('installedPackageSummary reads description and homepage', () => {
    assert.deepEqual(installedPackageSummary('linked-plugin', profileDir), {
      description: 'linked-plugin does things',
      repositoryUrl: 'https://github.com/owner/linked-plugin',
    })
  })
  ok('installedPackageSummary tolerates missing packages', () => {
    assert.deepEqual(installedPackageSummary('missing', profileDir), { description: null, repositoryUrl: null })
  })

  // ── installedEntries: linked rows ─────────────────────────────────────
  const manualGitHubSpec = `github:owner/linked-plugin#${'a'.repeat(40)}`
  const manifest = {
    name: 'test-profile',
    private: true,
    dsh: { profile: { bundles: ['linked-plugin'] } },
    dependencies: { 'linked-plugin': manualGitHubSpec },
  } as unknown as ProfileManifest
  const entries = installedEntries(manifest, profileDir, join(profileDir, 'node_modules'))
  const linked = entries.find(entry => entry.packageName === 'linked-plugin')
  ok('manual GitHub installs are listed with location, description, and bundle state', () => {
    assert.ok(linked !== undefined)
    assert.equal(linked?.linked, true)
    assert.equal(linked?.isBundle, true)
    assert.equal(linked?.enabled, true)
    assert.equal(linked?.location, join(profileDir, 'node_modules', 'linked-plugin'))
    assert.equal(linked?.description, 'linked-plugin does things')
    assert.equal(linked?.currentSpec, manualGitHubSpec)
  })

  // ── installedEntries: unlinked directory scan ─────────────────────────
  const pluginDir = join(tmp, 'plugins')
  const unlinked = join(pluginDir, 'unlinked-plugin')
  mkdirSync(unlinked, { recursive: true })
  writeFileSync(join(unlinked, 'package.json'), JSON.stringify({
    name: 'unlinked-plugin',
    version: '0.9.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  writeFileSync(join(unlinked, 'cordis.patch.yml'), '- insert:\n    - id: unlinked\n      name: unlinked-plugin\n')
  // Plain directory without a bundle patch must be ignored.
  mkdirSync(join(pluginDir, 'plain-dir'), { recursive: true })
  writeFileSync(join(pluginDir, 'plain-dir', 'package.json'), JSON.stringify({ name: 'plain-dir', version: '1.0.0' }))
  // Scoped folder two levels deep.
  const scoped = join(pluginDir, '@scope', 'scoped-plugin')
  mkdirSync(scoped, { recursive: true })
  writeFileSync(join(scoped, 'package.json'), JSON.stringify({
    name: '@scope/scoped-plugin',
    version: '0.1.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  writeFileSync(join(scoped, 'cordis.patch.yml'), '- insert:\n    - id: scoped\n      name: @scope/scoped-plugin\n')

  const scanned = installedEntries(manifest, profileDir, pluginDir)
  const unlinkedEntry = scanned.find(entry => entry.packageName === 'unlinked-plugin')
  ok('unlinked bundle directory is reported with linked=false', () => {
    assert.ok(unlinkedEntry !== undefined)
    assert.equal(unlinkedEntry?.linked, false)
    assert.equal(unlinkedEntry?.enabled, false)
    assert.equal(unlinkedEntry?.location, unlinked)
    assert.equal(unlinkedEntry?.currentSpec, '')
  })
  ok('scoped unlinked directories are discovered two levels deep', () => {
    const scopedEntry = scanned.find(entry => entry.packageName === '@scope/scoped-plugin')
    assert.ok(scopedEntry !== undefined)
    assert.equal(scopedEntry?.linked, false)
  })
  ok('plain directories without bundle patches are ignored', () => {
    assert.ok(scanned.every(entry => entry.packageName !== 'plain-dir'))
  })
  ok('linked dependencies are not duplicated by the directory scan', () => {
    assert.equal(scanned.filter(entry => entry.packageName === 'linked-plugin').length, 1)
  })
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log('profile-entries tests passed: ' + passed)
