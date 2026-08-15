/** Unit tests for install-location resolution, persistence, and links.
 *  Run: node --experimental-strip-types scripts/install-location-test.ts
 *  Covers PR notes §14 items 5–9 (directory switching, file: spec forms,
 *  junctions/symlinks, scoped folder names, peer dependency aliases).
 */

import { strict as assert } from 'node:assert'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ProfileManifest } from '@deepseek-ai/dsh-app-boot'
import {
  createProfilePackageLink,
  installedPluginTarget,
  linkProfilePeerDependencies,
  localDependencySpec,
  managedInstalledPluginTarget,
  marketplaceSettingsPath,
  persistInstallLocation,
  pluginFolderName,
  pluginTarget,
  readMarketplaceSettings,
  type ProfileInstallLocation,
} from '../src/host/install-location.ts'

let passed = 0
function ok(name: string, fn: () => void): void {
  fn()
  passed += 1
  console.log('ok - ' + name)
}

const tmp = mkdtempSync(join(tmpdir(), 'mkt-location-test-'))
const previousDshHome = process.env.DSH_HOME
try {
  const dshHome = join(tmp, 'dsh-home')
  process.env.DSH_HOME = dshHome

  // ── folder naming ─────────────────────────────────────────────────────
  ok('pluginFolderName preserves scopes', () => {
    assert.equal(pluginFolderName('@scope/plugin'), '@scope/plugin')
    assert.equal(pluginFolderName('plain'), 'plain')
  })

  // ── pluginTarget / installedPluginTarget ──────────────────────────────
  const profile: ProfileInstallLocation = {
    dir: join(tmp, 'profile'),
    name: 'web',
    custom: true,
    pluginDir: join(tmp, 'plugins'),
    storeDir: null,
  }
  ok('pluginTarget keeps scoped packages in separate directories', () => {
    assert.equal(pluginTarget(profile, '@scope/plugin'), join(profile.pluginDir, '@scope', 'plugin'))
    assert.notEqual(pluginTarget(profile, '@scope-a/plugin'), pluginTarget(profile, '@scope-b/plugin'))
  })

  const manifestWithDir = { name: 'p', dependencies: { plugin: 'file:./plugins/plugin' } } as unknown as ProfileManifest
  ok('installedPluginTarget honors file: directory specs', () => {
    assert.equal(installedPluginTarget(profile, 'plugin', manifestWithDir), resolve(profile.dir, 'plugins/plugin'))
  })

  const manifestWithTgz = { name: 'p', dependencies: { plugin: 'file:.marketplace-packages/plugin-1.0.0.tgz' } } as unknown as ProfileManifest
  ok('installedPluginTarget falls back for file: tarball specs', () => {
    assert.equal(installedPluginTarget(profile, 'plugin', manifestWithTgz), pluginTarget(profile, 'plugin'))
  })

  ok('installedPluginTarget falls back when no spec', () => {
    assert.equal(installedPluginTarget(profile, 'plugin', { name: 'p' } as ProfileManifest), pluginTarget(profile, 'plugin'))
  })

  // ── localDependencySpec ───────────────────────────────────────────────
  ok('localDependencySpec emits relative file: specs', () => {
    assert.equal(localDependencySpec(profile.dir, join(profile.dir, 'plugins', 'plugin')), 'file:./plugins/plugin')
  })
  if (process.platform === 'win32') {
    ok('localDependencySpec emits an absolute file spec across Windows drives', () => {
      assert.equal(localDependencySpec('C:/dsh/profile', 'D:/plugins/plugin'), 'file:D:/plugins/plugin')
    })
  }

  // ── settings persistence and directory switching ──────────────────────
  ok('persistInstallLocation writes custom dir and remembers roots', () => {
    const first = persistInstallLocation(profile.dir, join(tmp, 'custom-a'))
    assert.equal(first.installDirCustom, true)
    assert.equal(first.installDir, resolve(join(tmp, 'custom-a')))
    assert.ok(existsSync(marketplaceSettingsPath()))
    const settings = readMarketplaceSettings()
    assert.equal(settings.installDir, resolve(join(tmp, 'custom-a')))
    assert.ok(settings.pluginRoots.includes(resolve(profile.dir, 'node_modules')))
  })

  ok('persistInstallLocation resets to the default and keeps old roots', () => {
    const second = persistInstallLocation(profile.dir, join(tmp, 'custom-b'))
    assert.equal(second.installDirCustom, true)
    const reset = persistInstallLocation(profile.dir, '')
    assert.equal(reset.installDirCustom, false)
    assert.equal(reset.installDir, resolve(profile.dir, 'node_modules'))
    const roots = readMarketplaceSettings().pluginRoots
    assert.ok(roots.includes(resolve(join(tmp, 'custom-a'))))
    assert.ok(roots.includes(resolve(join(tmp, 'custom-b'))))
  })

  const oldScopedTarget = join(tmp, 'custom-a', '@scope', 'plugin')
  mkdirSync(oldScopedTarget, { recursive: true })
  writeFileSync(join(oldScopedTarget, 'package.json'), JSON.stringify({ name: '@scope/plugin', version: '1.0.0' }))
  const switchedProfile = { ...profile, pluginDir: join(tmp, 'custom-b') }
  const switchedManifest = {
    name: 'p',
    dependencies: { '@scope/plugin': localDependencySpec(profile.dir, oldScopedTarget) },
  } as unknown as ProfileManifest
  ok('managed installed target remains the old entity after directory switching', () => {
    assert.equal(managedInstalledPluginTarget(switchedProfile, '@scope/plugin', switchedManifest), oldScopedTarget)
  })

  // ── host peer dependency linking ──────────────────────────────────────
  const hostProfile = join(tmp, 'host-profile')
  mkdirSync(join(hostProfile, 'node_modules', '@deepseek-ai', 'cordis'), { recursive: true })
  writeFileSync(join(hostProfile, 'node_modules', '@deepseek-ai', 'cordis', 'package.json'), JSON.stringify({ name: '@deepseek-ai/cordis', version: '4.0.1' }))

  const pluginDir = join(tmp, 'peer-plugin')
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({
    name: 'peer-plugin',
    version: '1.0.0',
    peerDependencies: { cordis: '^4.0.0-rc.7', 'optional-peer': '^1.0.0' },
    peerDependenciesMeta: { 'optional-peer': { optional: true } },
  }))

  ok('linkProfilePeerDependencies links aliased host peers and skips optional', () => {
    const linked = linkProfilePeerDependencies(pluginDir, hostProfile)
    assert.deepEqual(linked, ['cordis'])
    const link = join(pluginDir, 'node_modules', 'cordis')
    assert.ok(existsSync(link))
    assert.ok(lstatSync(link).isSymbolicLink() || lstatSync(link).isDirectory())
  })

  const stalePeerPlugin = join(tmp, 'stale-peer-plugin')
  mkdirSync(join(stalePeerPlugin, 'node_modules', 'cordis'), { recursive: true })
  writeFileSync(join(stalePeerPlugin, 'package.json'), JSON.stringify({
    name: 'stale-peer-plugin',
    version: '1.0.0',
    peerDependencies: { cordis: '^4.0.0' },
  }))
  writeFileSync(join(stalePeerPlugin, 'node_modules', 'cordis', 'package.json'), JSON.stringify({ name: 'cordis', version: '0.0.0' }))
  ok('linkProfilePeerDependencies replaces an auto-installed peer with the Host peer', () => {
    assert.deepEqual(linkProfilePeerDependencies(stalePeerPlugin, hostProfile), ['cordis'])
    assert.ok(lstatSync(join(stalePeerPlugin, 'node_modules', 'cordis')).isSymbolicLink())
  })

  const missingRequired = join(tmp, 'missing-peer-plugin')
  mkdirSync(missingRequired, { recursive: true })
  writeFileSync(join(missingRequired, 'package.json'), JSON.stringify({
    name: 'missing-peer-plugin',
    version: '1.0.0',
    peerDependencies: { 'never-provided': '^1.0.0' },
  }))
  ok('linkProfilePeerDependencies throws for missing required peers', () => {
    assert.throws(() => linkProfilePeerDependencies(missingRequired, hostProfile), /Required host peer dependency/)
  })

  // ── profile package link (junction on Windows, symlink elsewhere) ─────
  const linkProfile = join(tmp, 'link-profile')
  const entity = join(tmp, 'entity')
  mkdirSync(entity, { recursive: true })
  const state = createProfilePackageLink(linkProfile, '@scope/plugin', entity, 'job-1')
  ok('createProfilePackageLink creates the runtime entry link', () => {
    assert.ok(existsSync(state.linkPath))
    assert.ok(lstatSync(state.linkPath).isSymbolicLink())
    assert.equal(state.backupCreated, false)
  })

  writeFileSync(join(state.linkPath, 'marker.txt'), 'x')
  const second = createProfilePackageLink(linkProfile, '@scope/plugin', entity, 'job-2')
  ok('createProfilePackageLink backs up and restores an existing entry', () => {
    assert.equal(second.backupCreated, true)
    assert.ok(existsSync(join(second.backupPath, 'marker.txt')))
  })
} finally {
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
  rmSync(tmp, { recursive: true, force: true })
}

console.log('install-location tests passed: ' + passed)
