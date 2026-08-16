/** Inspect the DSH profile produced by the trusted CLI without loading plugin code. */

import { realpath, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const dshHome = required('DSH_HOME')
const profile = required('PLUGIN_PROFILE')
const packageName = required('PLUGIN_PACKAGE')
const expectedVersion = required('PLUGIN_VERSION')
const profileDir = path.join(dshHome, 'profiles', profile)
const profileManifest = JSON.parse(await readFile(path.join(profileDir, 'package.json'), 'utf8'))
if (typeof profileManifest.dependencies?.[packageName] !== 'string') {
  throw new Error('DSH profile did not record the requested package dependency')
}
const pluginDir = await realpath(path.join(profileDir, 'node_modules', ...packageName.split('/')))
const manifest = JSON.parse(await readFile(path.join(pluginDir, 'package.json'), 'utf8'))
if (manifest.name !== packageName || manifest.version !== expectedVersion) {
  throw new Error('installed package identity differs from the Registry target')
}
const patch = manifest.dsh?.bundle?.patch
if (typeof patch !== 'string' || !safeRelative(patch)) throw new Error('installed package has no safe dsh.bundle.patch')
await stat(path.join(pluginDir, ...patch.replace(/^\.\//, '').split('/')))
const clientEntry = resolveClientEntry(manifest)
await writeFile('/work/install-inspection.json', JSON.stringify({
  profileDir,
  pluginDir,
  dependencySpec: profileManifest.dependencies[packageName],
  manifest: {
    name: manifest.name,
    version: manifest.version,
    bundlePatch: patch,
    hasClient: clientEntry !== null || manifest.dsh?.client?.platform === 'web',
    clientEntry,
  },
}, null, 2) + '\n', 'utf8')

function resolveClientEntry(manifest) {
  const value = manifest.exports?.['./client']
  const resolved = conditional(value)
  if (resolved === null) return null
  const normalized = resolved.replace(/^\.\//, '').replace(/\\/g, '/')
  return safeRelative(normalized) ? normalized : null
}

function conditional(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(conditional).find(Boolean) ?? null
  if (typeof value !== 'object' || value === null) return null
  for (const key of ['browser', 'import', 'default', 'require']) {
    const candidate = conditional(value[key])
    if (candidate !== null) return candidate
  }
  return null
}

function safeRelative(value) {
  const normalized = value.replace(/^\.\//, '')
  return normalized !== '' && !normalized.startsWith('/') && !/^[A-Za-z]:/.test(normalized) && !normalized.split(/[\\/]/).includes('..')
}

function required(name) {
  const value = process.env[name]
  if (typeof value !== 'string' || value === '') throw new Error(name + ' is required')
  return value
}
