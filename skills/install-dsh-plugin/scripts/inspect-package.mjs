#!/usr/bin/env node

/** Read-only preflight for an exact DSH plugin checkout. Uses Node built-ins only. */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'

const LIFECYCLE_NAMES = new Set(['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack', 'prepublish', 'prepublishOnly'])
const RESERVED_CONTEXT_FIELDS = new Set(['baseDir', 'collect', 'config', 'dispose', 'effect', 'extend', 'fork', 'get', 'inject', 'isolate', 'logger', 'main', 'mix', 'name', 'off', 'on', 'once', 'parallel', 'plugin', 'provide', 'root', 'scope', 'serial', 'set', 'update', 'waterfall', 'internal'])
const options = parseArgs(process.argv.slice(2))
for (const required of ['source', 'expected-package', 'expected-version', 'expected-commit', 'expected-patch']) {
  if (!options[required]) failUsage(`missing --${required}`)
}

const source = resolve(options.source)
const profileDir = options['profile-dir'] ? resolve(options['profile-dir']) : null
const errors = []
const warnings = []
const manifestPath = resolveInside(source, 'package.json', errors)
const manifest = readJson(manifestPath, errors, 'package.json')
const expectedCommit = options['expected-commit'].toLowerCase()

if (!/^[0-9a-f]{40}$/.test(expectedCommit)) errors.push('expected commit must be a full 40-character SHA')
const git = spawnSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8', shell: false })
const head = git.status === 0 ? git.stdout.trim().toLowerCase() : ''
if (head === '') errors.push('source is not a readable Git checkout')
else if (head !== expectedCommit) errors.push(`Git HEAD mismatch: expected ${expectedCommit}, found ${head}`)

const status = spawnSync('git', ['-C', source, 'status', '--porcelain'], { encoding: 'utf8', shell: false })
const clean = status.status === 0 && status.stdout.trim() === ''
if (!clean) warnings.push('checkout has local changes; rerun preflight before building or explain generated changes')

if (manifest?.name !== options['expected-package']) errors.push(`package name mismatch: expected ${options['expected-package']}, found ${String(manifest?.name)}`)
if (manifest?.version !== options['expected-version']) errors.push(`package version mismatch: expected ${options['expected-version']}, found ${String(manifest?.version)}`)

const declaredPatch = manifest?.dsh?.bundle?.patch
if (declaredPatch !== options['expected-patch']) errors.push(`bundle patch mismatch: expected ${options['expected-patch']}, found ${String(declaredPatch)}`)
const patchPath = typeof declaredPatch === 'string' ? resolveInside(source, declaredPatch, errors) : null
const patchSource = patchPath === null ? '' : readText(patchPath, errors, 'bundle patch')
if (patchSource.trim() === '') errors.push('declared bundle patch is missing or empty')
const patchRows = extractPatchRows(patchSource)
if (patchRows.length === 0) errors.push('bundle patch has no readable insert rows')
const internalIds = new Set()
for (const row of patchRows) {
  if (internalIds.has(row.id)) errors.push(`bundle patch repeats id: ${row.id}`)
  internalIds.add(row.id)
}

const lifecycleScripts = Object.entries(manifest?.scripts ?? {})
  .filter(([name, command]) => LIFECYCLE_NAMES.has(name) && typeof command === 'string' && command.trim() !== '')
  .map(([name]) => name)
if (lifecycleScripts.length > 0) warnings.push('lifecycle scripts require an explicit decision: ' + lifecycleScripts.join(', '))

const runtimeEntries = []
const rootEntry = packageEntry(manifest, '.')
if (rootEntry === null) errors.push('package has no Host runtime entry')
else runtimeEntries.push(checkEntry(source, rootEntry, errors, 'Host'))
if (manifest?.dsh?.client !== undefined) {
  const clientEntry = packageEntry(manifest, './client')
  if (clientEntry === null) errors.push('package declares dsh.client but has no ./client runtime export')
  else runtimeEntries.push(checkEntry(source, clientEntry, errors, 'client'))
}

const conflicts = profileDir === null
  ? { bundleIds: [], services: [] }
  : findConflicts(profileDir, source, patchRows, manifest?.name, errors, warnings)
for (const conflict of conflicts.bundleIds) errors.push(`bundle id conflict: ${conflict.id} is already provided by ${conflict.owner}`)
for (const conflict of conflicts.services) errors.push(`Cordis service conflict: ${conflict.service} is already provided by ${conflict.owner}`)

const result = {
  ok: errors.length === 0,
  source,
  profileDir,
  identity: { packageName: manifest?.name ?? null, version: manifest?.version ?? null, head, clean },
  bundle: { patch: declaredPatch ?? null, rows: patchRows },
  runtimeEntries,
  lifecycleScripts,
  conflicts,
  errors,
  warnings,
}
process.stdout.write(JSON.stringify(result, null, 2) + '\n')
process.exitCode = result.ok ? 0 : 2

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) failUsage('arguments must be --name value pairs')
    parsed[key.slice(2)] = value
  }
  return parsed
}

function failUsage(message) {
  process.stderr.write(`inspect-package: ${message}\n`)
  process.exit(64)
}

function resolveInside(root, value, errors) {
  if (typeof value !== 'string' || value.trim() === '' || isAbsolute(value)) {
    errors.push(`unsafe package-relative path: ${String(value)}`)
    return null
  }
  const target = resolve(root, value)
  const rel = relative(root, target)
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) {
    errors.push(`path escapes package root: ${value}`)
    return null
  }
  if (existsSync(target)) {
    const realRoot = realpathSync(root)
    const realTarget = realpathSync(target)
    const realRel = relative(realRoot, realTarget)
    if (realRel === '..' || realRel.startsWith('../') || realRel.startsWith('..\\') || isAbsolute(realRel)) {
      errors.push(`path follows a link outside package root: ${value}`)
      return null
    }
  }
  return target
}

function readJson(path, errors, label) {
  if (path === null || !existsSync(path)) {
    errors.push(`${label} is missing`)
    return null
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    errors.push(`${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

function readText(path, errors, label) {
  if (!existsSync(path)) {
    errors.push(`${label} is missing: ${path}`)
    return ''
  }
  try {
    return readFileSync(path, 'utf8').slice(0, 512 * 1024)
  } catch (error) {
    errors.push(`${label} is unreadable: ${error instanceof Error ? error.message : String(error)}`)
    return ''
  }
}

function packageEntry(manifest, key) {
  const exportsValue = manifest?.exports
  if (key === '.' && typeof exportsValue === 'string') return exportsValue
  if (exportsValue && typeof exportsValue === 'object') {
    const selected = exportsValue[key] ?? (key === '.' ? exportsValue.default : undefined)
    if (typeof selected === 'string') return selected
    if (selected && typeof selected === 'object' && typeof selected.default === 'string') return selected.default
  }
  return key === '.' && typeof manifest?.main === 'string' ? manifest.main : null
}

function checkEntry(root, entry, errors, label) {
  const path = resolveInside(root, entry, errors)
  const exists = path !== null && existsSync(path)
  if (!exists) errors.push(`${label} runtime entry is missing: ${entry}`)
  return { kind: label.toLowerCase(), entry, exists }
}

function extractPatchRows(source) {
  const rows = []
  let current = null
  let insertIndent = null
  const flush = () => {
    if (current?.id) rows.push({ id: current.id, name: current.name || current.id })
    current = null
  }
  for (const line of source.split(/\r?\n/)) {
    const insert = /^(\s*)-\s+insert:\s*$/.exec(line)
    if (insert) {
      flush()
      insertIndent = insert[1].length
      continue
    }
    const content = /^(\s*)\S/.exec(line)
    if (insertIndent !== null && content && content[1].length <= insertIndent) {
      flush()
      insertIndent = null
    }
    if (insertIndent === null) continue
    const id = /^\s*-\s+id:\s*(.+?)\s*$/.exec(line)
    if (id) {
      flush()
      current = { id: yamlScalar(id[1]), name: '' }
      continue
    }
    const name = /^\s*name:\s*(.+?)\s*$/.exec(line)
    if (name && current) current.name = yamlScalar(name[1])
  }
  flush()
  return rows
}

function yamlScalar(value) {
  let result = value.trim().replace(/\s+#.*$/, '').trim()
  if ((result.startsWith('"') && result.endsWith('"')) || (result.startsWith("'") && result.endsWith("'"))) result = result.slice(1, -1)
  return result.trim()
}

function findConflicts(profileDir, source, candidateRows, candidatePackage, errors, warnings) {
  const profile = readJson(resolve(profileDir, 'package.json'), errors, 'Profile package.json')
  const idOwners = new Map()
  const serviceOwners = new Map()
  for (const bundle of profile?.dsh?.profile?.bundles ?? []) {
    if (bundle === candidatePackage) continue
    const packageJson = resolvePackageManifest(profileDir, bundle)
    if (packageJson === null) continue
    const installed = readJson(packageJson, errors, `installed manifest ${bundle}`)
    const patch = installed?.dsh?.bundle?.patch
    if (typeof patch !== 'string') continue
    const installedRoot = dirname(packageJson)
    const installedPatch = resolveInside(installedRoot, patch, errors)
    if (installedPatch === null) continue
    for (const row of extractPatchRows(readText(installedPatch, errors, `installed patch ${bundle}`))) {
      if (!idOwners.has(row.id)) idOwners.set(row.id, bundle)
      for (const service of servicesForPackage(profileDir, row.name, errors, null)) {
        if (!serviceOwners.has(service)) serviceOwners.set(service, row.name)
      }
    }
  }
  const candidateServices = new Set()
  for (const row of candidateRows) {
    const services = row.name === candidatePackage
      ? servicesFromManifest(resolve(source, 'package.json'), errors)
      : servicesForPackage(source, row.name, errors, warnings)
    for (const service of services) candidateServices.add(service)
  }
  return {
    bundleIds: candidateRows.filter(row => idOwners.has(row.id)).map(row => ({ id: row.id, owner: idOwners.get(row.id) })),
    services: [...candidateServices].filter(service => serviceOwners.has(service)).map(service => ({ service, owner: serviceOwners.get(service) })),
  }
}

function resolvePackageManifest(profileDir, packageName) {
  try {
    const require = createRequire(resolve(profileDir, 'package.json'))
    return require.resolve(packageName + '/package.json')
  } catch {
    return null
  }
}

function servicesForPackage(baseDir, packageName, errors, warnings) {
  const manifestPath = resolvePackageManifest(baseDir, packageName)
  if (manifestPath === null) {
    if (warnings !== null) warnings.push(`cannot inspect services for ${packageName} until its dependencies are installed with scripts disabled`)
    return []
  }
  return servicesFromManifest(manifestPath, errors)
}

function servicesFromManifest(manifestPath, errors) {
  const plugin = readJson(manifestPath, errors, `service manifest ${manifestPath}`)
  const entry = packageEntry(plugin, '.')
  if (entry === null) return []
  const root = dirname(manifestPath)
  const entryPath = resolveInside(root, entry, errors)
  if (entryPath === null || !existsSync(entryPath)) return []
  const source = readText(entryPath, errors, `service entry ${entryPath}`)
  const services = new Set()
  for (const match of source.matchAll(/ctx\.provide\(\s*["']([^"']+)["']/g)) services.add(match[1])
  for (const match of source.matchAll(/super\(\s*ctx\s*,\s*["']([^"']+)["']/g)) services.add(match[1])
  for (const match of source.matchAll(/ctx\[\s*["']([^"']+)["']\s*\]\s*=(?!=)/g)) services.add(match[1])
  for (const match of source.matchAll(/ctx\.(\w+)\s*=(?!=)/g)) {
    if (!RESERVED_CONTEXT_FIELDS.has(match[1])) services.add(match[1])
  }
  return [...services]
}
