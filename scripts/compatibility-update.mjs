/** Optional update-state probe. It never imports either plugin version. */

import { execFile } from 'node:child_process'
import { realpath, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const packageName = required('PLUGIN_PACKAGE')
const currentVersion = required('PLUGIN_VERSION')
const profile = required('PLUGIN_PROFILE')
const dsh = '/work/runtime/node_modules/.bin/dsh'
const updateHome = '/work/update-home'
const output = '/work/update-probe.json'
let phase = 'metadata'

try {
  const previousVersion = await previousPublishedVersion(packageName, currentVersion)
  if (previousVersion === null) {
    await result('unsupported', 'no-earlier-stable-npm-version-is-published')
  } else {
    phase = 'previous-install'
    await runDsh(updateHome, profile, ['add', packageName + '@' + previousVersion, '--ignore-scripts'])
    const profileDir = path.join(updateHome, 'profiles', profile)
    const manifestPath = path.join(profileDir, 'package.json')
    const before = JSON.parse(await readFile(manifestPath, 'utf8'))
    const bundles = before.dsh?.profile?.bundles
    if (!Array.isArray(bundles) || !bundles.includes(packageName)) {
      await result('unsupported', 'previous-version-does-not-load-as-a-dsh-bundle')
    } else {
      before.dsh.profile.bundles = bundles.filter(value => value !== packageName)
      await writeFile(manifestPath, JSON.stringify(before, null, 2) + '\n', 'utf8')
      const patchPath = path.join(profileDir, 'cordis.patch.yml')
      let patch = '[]\n'
      try { patch = await readFile(patchPath, 'utf8') } catch {}
      const marker = '# marketplace-compatibility-update-marker\n'
      await writeFile(patchPath, patch + (patch.endsWith('\n') ? '' : '\n') + marker, 'utf8')
      phase = 'target-update'
      await runDsh(updateHome, profile, ['add', packageName + '@' + currentVersion, '--ignore-scripts'])
      const after = JSON.parse(await readFile(manifestPath, 'utf8'))
      const installedDir = await realpath(path.join(profileDir, 'node_modules', ...packageName.split('/')))
      const installed = JSON.parse(await readFile(path.join(installedDir, 'package.json'), 'utf8'))
      const afterPatch = await readFile(patchPath, 'utf8')
      if (installed.version !== currentVersion) throw new Error('update did not install the target version')
      if (after.dsh?.profile?.bundles?.includes(packageName)) throw new Error('update re-enabled a disabled bundle')
      if (!afterPatch.endsWith(marker)) throw new Error('update overwrote the Profile configuration patch')
      await result('passed', 'updated-from-' + previousVersion + '-while-preserving-disabled-state-and-profile-patch')
    }
  }
} catch (error) {
  const detail = reason(error)
  if (/EAI_AGAIN|ENETUNREACH|ECONNRESET|ETIMEDOUT|HTTP\s+(?:429|5\d\d)/i.test(detail)) {
    await result('inconclusive', 'update-probe-network-error: ' + detail)
  } else if (/update re-enabled a disabled bundle/i.test(detail)) {
    await result('inconclusive', 'official-dsh-cli-did-not-preserve-disabled-state-during-update')
  } else if (phase === 'previous-install') {
    await result('unsupported', 'previous-version-could-not-be-staged-without-scripts: ' + detail)
  } else {
    await result('failed', 'update-or-state-preservation-failed: ' + detail)
  }
}

async function previousPublishedVersion(name, current) {
  if (stableTuple(current) === null) return null
  const url = 'https://registry.npmjs.org/' + name.split('/').map(encodeURIComponent).join('/')
  const response = await fetch(url, { headers: { 'user-agent': 'dsh-marketplace-compatibility' }, signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error('npm metadata returned HTTP ' + response.status)
  const body = await response.json()
  const versions = Object.keys(body.versions ?? {})
    .filter(version => stableTuple(version) !== null && compare(version, current) < 0)
    .sort(compare)
  return versions.at(-1) ?? null
}

async function runDsh(home, profileName, pnpmArgs) {
  await execute(dsh, ['plugin', '--profile', profileName, ...pnpmArgs], {
    env: { PATH: process.env.PATH, HOME: '/work/user-home', DSH_HOME: home, CI: '1', NO_COLOR: '1' },
    timeout: 180_000,
    maxBuffer: 1024 * 1024,
  })
}

function compare(left, right) {
  const a = stableTuple(left)
  const b = stableTuple(right)
  if (a === null || b === null) return left.localeCompare(right)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

function stableTuple(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value)
  return match === null ? null : match.slice(1).map(Number)
}

async function result(status, value) {
  await writeFile(output, JSON.stringify({ status, reason: String(value).slice(0, 500) }, null, 2) + '\n', 'utf8')
}

function reason(error) {
  return [error?.stderr, error?.stdout, error?.message]
    .filter(value => typeof value === 'string' && value !== '')
    .join(' | ')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(-500) || String(error).slice(-500)
}

function required(name) {
  const value = process.env[name]
  if (typeof value !== 'string' || value === '') throw new Error(name + ' is required')
  return value
}
