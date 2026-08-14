/** Discover `dsh-plugin` topic candidates and publish the verified Registry. */

import { readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  InvalidCandidateError,
  INSTALL_CLASSIFIER_VERSION,
  MAX_MANIFEST_BYTES,
  MAX_PATCH_BYTES,
  MAX_README_BYTES,
  RetryCandidateError,
  candidateFingerprint,
  classifyInstall,
  encodeRawPath,
  normalizePackagePath,
  readmeGitHubRepositories,
  registryPluginId,
  refreshPluginMetadata,
  validateBundlePatch,
  validateManifest,
  verifiedPlugin,
} from './registry-core.mjs'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const token = process.env.GITHUB_TOKEN?.trim()
if (token === undefined || token === '') {
  throw new Error('GITHUB_TOKEN is required for the central Registry scan')
}

const apiHeaders = {
  accept: 'application/vnd.github+json',
  authorization: 'Bearer ' + token,
  'user-agent': 'dsh-plugin-registry',
  'x-github-api-version': '2022-11-28',
}
const rawHeaders = { 'user-agent': 'dsh-plugin-registry' }
const now = new Date().toISOString()
const MAX_PACKAGE_MANIFESTS = 256

const statePath = path.join(root, 'registry', 'state.json')
const pluginsPath = path.join(root, 'registry', 'plugins.json')
const rejectedPath = path.join(root, 'registry', 'rejected.json')
const installReviewPath = path.join(root, 'registry', 'install-review.json')
const denylistPath = path.join(root, 'policy', 'denylist.json')
const installOverridesPath = path.join(root, 'policy', 'install-overrides.json')

const previousState = await readJson(statePath)
const denylistDocument = await readJson(denylistPath)
const installOverridesDocument = await readJson(installOverridesPath)
const previous = plainObject(previousState.repositories) ? previousState.repositories : {}
const denylist = new Map((Array.isArray(denylistDocument.repositories) ? denylistDocument.repositories : []).map((entry) => {
  if (typeof entry === 'string') return [entry.toLocaleLowerCase(), 'manually blocked']
  if (plainObject(entry) && typeof entry.repo === 'string') {
    return [entry.repo.toLocaleLowerCase(), typeof entry.reason === 'string' ? entry.reason : 'manually blocked']
  }
  throw new Error('policy/denylist.json contains an invalid repository entry')
}))
const installOverrides = installOverrideMap(installOverridesDocument)

console.log('discovering repositories with topic:dsh-plugin')
const candidates = await discoverAll()
console.log('discovered ' + String(candidates.length) + ' candidate repositories')

const next = {}
let validated = 0
let reused = 0
let candidateIndex = 0
const workers = Math.min(6, candidates.length)
await Promise.all(Array.from({ length: workers }, async () => {
  for (;;) {
    const index = candidateIndex
    candidateIndex += 1
    if (index >= candidates.length) return
    await processCandidate(candidates[index])
  }
}))

async function processCandidate(candidate) {
  const key = candidate.full_name.toLocaleLowerCase()
  const repositoryOverrides = overridesForRepository(candidate.full_name)
  const fingerprint = candidateFingerprint(candidate, repositoryOverrides)
  const old = plainObject(previous[key]) ? previous[key] : undefined
  const blockedReason = denylist.get(key)
  if (blockedReason !== undefined) {
    next[key] = stateRow(candidate, fingerprint, 'blocked', blockedReason)
    return
  }
  if (old !== undefined
    && sameFingerprint(old.fingerprint, fingerprint)
    && old.status === 'verified'
    && validPluginCollection(old.plugins)
    && validInspectionCollection(old.inspections)) {
    next[key] = {
      ...stateRow(candidate, fingerprint, 'verified', null),
      checkedAt: old.checkedAt,
      commit: old.commit,
      plugins: old.plugins.map(plugin => refreshPluginMetadata(plugin, candidate)),
      inspections: old.inspections,
    }
    reused += 1
    return
  }
  if (old !== undefined && sameFingerprint(old.fingerprint, fingerprint) && old.status === 'invalid') {
    next[key] = { ...stateRow(candidate, fingerprint, 'invalid', old.reason), checkedAt: old.checkedAt }
    reused += 1
    return
  }
  try {
    const result = await validateCandidate(candidate)
    next[key] = {
      ...stateRow(candidate, fingerprint, 'verified', null),
      commit: result.commit,
      plugins: result.plugins,
      inspections: result.inspections,
    }
  } catch (error) {
    if (error instanceof InvalidCandidateError) {
      next[key] = stateRow(candidate, fingerprint, 'invalid', error.message)
    } else if (error instanceof RetryCandidateError) {
      next[key] = stateRow(candidate, fingerprint, 'retry', error.message)
    } else {
      throw error
    }
  }
  validated += 1
  if (validated % 25 === 0) console.log('validated ' + String(validated) + ' changed/new candidates')
}

for (const [key, value] of Object.entries(previous)) {
  if (next[key] !== undefined || !plainObject(value)) continue
  next[key] = { ...value, status: 'removed', reason: 'topic removed, repository archived, or repository deleted', checkedAt: now }
}

const plugins = Object.values(next)
  .filter(row => plainObject(row) && row.status === 'verified' && validPluginCollection(row.plugins))
  .flatMap(row => row.plugins)
  .sort((left, right) => left.id.localeCompare(right.id))
const rejected = Object.values(next)
  .filter(row => plainObject(row) && row.status !== 'verified')
  .map(row => ({
    repository: row.repository,
    status: row.status,
    reason: row.reason,
    checkedAt: row.checkedAt,
  }))
  .sort((left, right) => left.repository.localeCompare(right.repository))
const installReview = installReviewRows(next)

await atomicJson(statePath, { schemaVersion: 3, generatedAt: now, repositories: sortObject(next) })
await atomicJson(pluginsPath, { schemaVersion: 3, generatedAt: now, plugins })
await atomicJson(rejectedPath, { schemaVersion: 1, generatedAt: now, repositories: rejected })
await atomicJson(installReviewPath, { schemaVersion: 1, generatedAt: now, repositories: installReview })
console.log(
  'published ' + String(plugins.length) + ' verified plugins; '
  + String(rejected.length) + ' hidden; '
  + String(installReview.filter(row => row.status === 'needs-review').length) + ' install classifications need review; '
  + String(installReview.filter(row => row.status === 'auto-resolved').length) + ' prepare false positives auto-resolved; '
  + 'reused ' + String(reused),
)

async function discoverAll() {
  const base = 'topic:dsh-plugin archived:false fork:false'
  const first = await searchPage(base, 1)
  if (first.totalCount <= 1000) return await remainingPages(base, first)
  const start = new Date(Date.UTC(2008, 0, 1))
  const end = new Date()
  const partitions = await discoverRange(start, end)
  return dedupe(partitions.flat())
}

async function discoverRange(start, end) {
  const qualifier = ' created:' + date(start) + '..' + date(end)
  const query = 'topic:dsh-plugin archived:false fork:false' + qualifier
  const first = await searchPage(query, 1)
  if (first.totalCount <= 1000) return [await remainingPages(query, first)]
  const days = Math.floor((end.getTime() - start.getTime()) / 86_400_000)
  if (days <= 0) throw new Error('More than 1,000 dsh-plugin candidates share creation date ' + date(start))
  const leftDays = Math.floor(days / 2)
  const middle = new Date(start.getTime() + leftDays * 86_400_000)
  const rightStart = new Date(middle.getTime() + 86_400_000)
  const left = await discoverRange(start, middle)
  const right = await discoverRange(rightStart, end)
  return [...left, ...right]
}

async function remainingPages(query, first) {
  const pages = Math.ceil(first.totalCount / 100)
  const rows = [...first.items]
  for (let page = 2; page <= pages; page += 1) rows.push(...(await searchPage(query, page)).items)
  return dedupe(rows)
}

async function searchPage(query, page) {
  const url = new URL('https://api.github.com/search/repositories')
  url.searchParams.set('q', query)
  url.searchParams.set('sort', 'updated')
  url.searchParams.set('order', 'desc')
  url.searchParams.set('per_page', '100')
  url.searchParams.set('page', String(page))
  const response = await apiJson(url)
  const items = Array.isArray(response.items) ? response.items.filter(validCandidateSummary) : []
  return { totalCount: integer(response.total_count), items }
}

async function validateCandidate(candidate) {
  const commitResponse = await apiJson(new URL(
    'https://api.github.com/repos/' + candidate.full_name + '/commits/' + encodeURIComponent(candidate.default_branch),
  ), true)
  const commit = commitResponse.sha
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/i.test(commit)) {
    throw new RetryCandidateError('GitHub did not return the default-branch commit SHA')
  }
  const rawBase = 'https://raw.githubusercontent.com/' + candidate.full_name + '/' + commit + '/'
  const treeResponse = await apiJson(new URL(
    'https://api.github.com/repos/' + candidate.full_name + '/git/trees/' + commit + '?recursive=1',
  ), true)
  const treePaths = Array.isArray(treeResponse.tree)
    ? treeResponse.tree
      .filter(entry => plainObject(entry) && entry.type === 'blob' && typeof entry.path === 'string')
      .map(entry => entry.path)
    : []
  const manifestPaths = treePaths
    .filter(value => value === 'package.json' || value.endsWith('/package.json'))
    .filter(value => !value.split('/').includes('node_modules'))
    .sort((left, right) => pathDepth(left) - pathDepth(right) || left.localeCompare(right))
  if (manifestPaths.length > MAX_PACKAGE_MANIFESTS) {
    throw new InvalidCandidateError('repository contains more than ' + String(MAX_PACKAGE_MANIFESTS) + ' package.json files; narrow the plugin workspace')
  }
  const rootReadmePath = preferredReadme(treePaths)
  const rootReadmeText = rootReadmePath === null
    ? null
    : await optionalRawText(new URL(rawBase + encodeRawPath(rootReadmePath)), MAX_README_BYTES, rootReadmePath)
  const plugins = []
  const inspections = []
  for (const manifestPath of manifestPaths) {
    const packagePath = normalizePackagePath(path.posix.dirname(manifestPath) === '.' ? '' : path.posix.dirname(manifestPath))
    try {
      const manifestText = await rawText(new URL(rawBase + encodeRawPath(manifestPath)), MAX_MANIFEST_BYTES, manifestPath)
      const identity = validateManifest(manifestText)
      const packageTreePaths = relativePackagePaths(treePaths, packagePath)
      if (treeResponse.truncated === true) {
        const known = new Set(packageTreePaths)
        for (const group of identity.installHints.runtimeEntryGroups) {
          for (const entryPath of group.paths) {
            if (!known.has(entryPath) && await rawExists(packageRawUrl(rawBase, packagePath, entryPath))) {
              packageTreePaths.push(entryPath)
              known.add(entryPath)
            }
          }
        }
      }
      const packageReadmePath = preferredReadme(packageTreePaths)
      const readmeText = packageReadmePath === null
        ? rootReadmeText
        : await optionalRawText(
          packageRawUrl(rawBase, packagePath, packageReadmePath),
          MAX_README_BYTES,
          joinPackagePath(packagePath, packageReadmePath),
        )
      const verifiedGitHubRepositories = await verifiedReadmeRepositories(candidate, readmeText)
      const classification = classifyInstall(
        identity,
        candidate.full_name,
        packageTreePaths,
        readmeText,
        verifiedGitHubRepositories,
        packagePath,
      )
      if (suspiciousPackagePath(packagePath) && !classification.inspection.readme.directGitHub) continue
      const patchLabel = joinPackagePath(packagePath, classification.identity.bundlePatch)
      const patchText = await rawText(
        packageRawUrl(rawBase, packagePath, classification.identity.bundlePatch),
        MAX_PATCH_BYTES,
        patchLabel,
      )
      validateBundlePatch(patchText, classification.identity.packageName)
      const id = registryPluginId(candidate.full_name, packagePath)
      const installOverride = installOverrides.get(id.toLocaleLowerCase())
      plugins.push(verifiedPlugin(candidate, commit, classification.identity, now, installOverride, packagePath))
      inspections.push({
        id,
        packagePath,
        ...classification.inspection,
        treeTruncated: treeResponse.truncated === true,
      })
    } catch (error) {
      if (error instanceof InvalidCandidateError) continue
      throw error
    }
  }
  if (plugins.length === 0) {
    throw new InvalidCandidateError('no package.json in the repository declares a valid DSH bundle')
  }
  return {
    commit,
    plugins,
    inspections,
  }
}

async function apiJson(url, candidateRequest = false) {
  let response
  try {
    response = await fetchWithRetry(url, { headers: apiHeaders }, 3)
  } catch (error) {
    if (candidateRequest) throw new RetryCandidateError('GitHub API request failed: ' + messageOf(error))
    throw error
  }
  if (response.status === 401) throw new Error('GitHub rejected GITHUB_TOKEN')
  if (response.status === 403 || response.status === 429) {
    const reset = response.headers.get('x-ratelimit-reset')
    const message = 'GitHub API rate limit reached' + (reset === null ? '' : '; reset epoch ' + reset)
    if (candidateRequest) throw new RetryCandidateError(message)
    throw new Error(message)
  }
  if (response.status === 404 && candidateRequest) throw new InvalidCandidateError('default branch has no readable commit')
  if (!response.ok) {
    const message = 'GitHub API returned HTTP ' + String(response.status)
    if (candidateRequest && response.status >= 500) throw new RetryCandidateError(message)
    if (candidateRequest) throw new InvalidCandidateError(message)
    throw new Error(message)
  }
  return await response.json()
}

async function rawText(url, maximum, label) {
  let response
  try {
    response = await fetchWithRetry(url, { headers: rawHeaders }, 2)
  } catch (error) {
    throw new RetryCandidateError('could not read ' + label + ': ' + messageOf(error))
  }
  if (response.status === 403 || response.status === 429) {
    throw new RetryCandidateError(label + ' was rate-limited by GitHub')
  }
  if (response.status === 404) throw new InvalidCandidateError(label + ' does not exist at the verified commit')
  if (response.status >= 500) throw new RetryCandidateError(label + ' returned HTTP ' + String(response.status))
  if (!response.ok) throw new InvalidCandidateError(label + ' returned HTTP ' + String(response.status))
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > maximum) throw new InvalidCandidateError(label + ' exceeds ' + String(maximum) + ' bytes')
  if (response.body === null) throw new RetryCandidateError(label + ' returned no response body')
  const reader = response.body.getReader()
  const chunks = []
  let length = 0
  for (;;) {
    const part = await reader.read()
    if (part.done) break
    length += part.value.byteLength
    if (length > maximum) {
      await reader.cancel()
      throw new InvalidCandidateError(label + ' exceeds ' + String(maximum) + ' bytes')
    }
    chunks.push(part.value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new InvalidCandidateError(label + ' is not valid UTF-8')
  }
}

async function optionalRawText(url, maximum, label) {
  try {
    return await rawText(url, maximum, label)
  } catch (error) {
    if (error instanceof InvalidCandidateError) return null
    throw error
  }
}

async function rawExists(url) {
  let response
  try {
    response = await fetchWithRetry(url, { headers: { ...rawHeaders, range: 'bytes=0-0' } }, 2)
  } catch (error) {
    throw new RetryCandidateError('could not probe runtime entry: ' + messageOf(error))
  }
  if (response.status === 404) return false
  if (response.status === 403 || response.status === 429 || response.status >= 500) {
    throw new RetryCandidateError('runtime entry probe returned HTTP ' + String(response.status))
  }
  await response.body?.cancel()
  return response.ok
}

async function verifiedReadmeRepositories(candidate, readmeText) {
  const verified = [candidate.full_name]
  if (readmeText === null) return verified
  const current = candidate.full_name.toLocaleLowerCase()
  const currentName = candidate.name.toLocaleLowerCase()
  for (const repository of readmeGitHubRepositories(readmeText)) {
    const normalized = repository.toLocaleLowerCase()
    if (normalized === current || repository.split('/')[1]?.toLocaleLowerCase() !== currentName) continue
    let response
    try {
      response = await fetchWithRetry(
        new URL('https://api.github.com/repos/' + repository),
        { headers: apiHeaders },
        2,
      )
    } catch (error) {
      throw new RetryCandidateError('could not verify README GitHub repository alias: ' + messageOf(error))
    }
    if (response.status === 404) continue
    if (response.status === 403 || response.status === 429 || response.status >= 500) {
      throw new RetryCandidateError('README GitHub repository alias returned HTTP ' + String(response.status))
    }
    if (!response.ok) continue
    const resolved = await response.json()
    if (plainObject(resolved) && resolved.id === candidate.id) verified.push(repository)
  }
  return verified
}

async function fetchWithRetry(url, options, attempts) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(20_000) })
      if (response.status < 500 || attempt === attempts) return response
      await response.body?.cancel()
    } catch (error) {
      lastError = error
    }
    if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 250 * (2 ** (attempt - 1))))
  }
  throw lastError
}

function stateRow(candidate, fingerprint, status, reason) {
  return { repository: candidate.full_name, fingerprint, status, reason, checkedAt: now }
}

function validCandidateSummary(value) {
  return plainObject(value)
    && typeof value.full_name === 'string'
    && /^[\w.-]+\/[\w.-]+$/.test(value.full_name)
    && typeof value.name === 'string'
    && typeof value.default_branch === 'string'
    && value.default_branch !== ''
    && typeof value.html_url === 'string'
    && typeof value.pushed_at === 'string'
    && typeof value.updated_at === 'string'
}

function dedupe(rows) {
  return [...new Map(rows.map(row => [row.full_name.toLocaleLowerCase(), row])).values()]
    .sort((left, right) => left.full_name.localeCompare(right.full_name))
}

/** Accept the legacy two-line fingerprint once when no install override exists. */
function sameFingerprint(previousFingerprint, currentFingerprint) {
  if (typeof previousFingerprint !== 'string') return false
  const previousParts = previousFingerprint.split('\n')
  const currentParts = currentFingerprint.split('\n')
  if (previousParts.length === 2 && currentParts[2] === 'null') {
    return previousFingerprint === currentParts.slice(0, 2).join('\n')
  }
  return previousFingerprint === currentFingerprint
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

async function atomicJson(file, value) {
  const temporary = file + '.tmp'
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8')
  await rename(temporary, file)
}

function sortObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
}

function date(value) {
  return value.toISOString().slice(0, 10)
}

function integer(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validInstallMetadata(value) {
  return plainObject(value)
    && (value.mode === 'automatic' || value.mode === 'guided')
    && typeof value.spec === 'string'
    && Array.isArray(value.profiles)
    && typeof value.instructionsUrl === 'string'
}

function validPluginCollection(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.every(plugin => plainObject(plugin)
      && typeof plugin.id === 'string'
      && typeof plugin.packagePath === 'string'
      && validInstallMetadata(plugin.install))
}

function validInspectionCollection(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.every(inspection => plainObject(inspection)
      && typeof inspection.id === 'string'
      && typeof inspection.packagePath === 'string'
      && validInspection(inspection))
}

function validInspection(value) {
  return plainObject(value)
    && value.classifierVersion === INSTALL_CLASSIFIER_VERSION
    && Array.isArray(value.profiles)
    && Array.isArray(value.artifactGroups)
    && Array.isArray(value.reviewReasons)
    && Array.isArray(value.resolvedReasons)
    && plainObject(value.readme)
}

function preferredReadme(paths) {
  const roots = paths.filter(value => typeof value === 'string' && !value.includes('/') && /^readme(?:\.[\w-]+)*$/i.test(value))
  roots.sort((left, right) => {
    const rank = value => /^readme\.md$/i.test(value) ? 0 : /\.md$/i.test(value) ? 1 : 2
    return rank(left) - rank(right) || left.localeCompare(right)
  })
  return roots[0] ?? null
}

function installReviewRows(state) {
  const rows = []
  for (const row of Object.values(state)) {
    if (!plainObject(row) || row.status !== 'verified' || !validPluginCollection(row.plugins) || !validInspectionCollection(row.inspections)) continue
    const plugins = new Map(row.plugins.map(plugin => [plugin.id, plugin]))
    for (const inspection of row.inspections) {
      const plugin = plugins.get(inspection.id)
      if (plugin === undefined) continue
      if (inspection.reviewReasons.length > 0) {
        rows.push(reviewRow(row, plugin, inspection, 'needs-review', inspection.reviewReasons))
      } else if (plugin.install.mode === 'automatic' && inspection.resolvedReasons.length > 0) {
        rows.push(reviewRow(row, plugin, inspection, 'auto-resolved', inspection.resolvedReasons))
      }
    }
  }
  return rows.sort((left, right) => left.id.localeCompare(right.id))
}

function reviewRow(row, plugin, inspection, status, reasons) {
  return {
    repository: row.repository,
    id: plugin.id,
    packagePath: plugin.packagePath,
    status,
    mode: plugin.install.mode,
    reasons,
    profiles: inspection.profiles,
    profileSource: inspection.profileSource,
    lifecycleScripts: inspection.lifecycleScripts,
    runtimeArtifactsCommitted: inspection.runtimeArtifactsCommitted,
    artifactGroups: inspection.artifactGroups,
    readme: inspection.readme,
    checkedAt: row.checkedAt,
  }
}

function installOverrideMap(document) {
  if (!plainObject(document) || document.schemaVersion !== 1 || !plainObject(document.repositories)) {
    throw new Error('policy/install-overrides.json has an invalid root object')
  }
  const result = new Map()
  for (const [id, value] of Object.entries(document.repositories)) {
    const match = /^([\w.-]+\/[\w.-]+)(?:&path:\/(.+))?$/.exec(id)
    if (match === null || !plainObject(value)) {
      throw new Error('invalid install override for ' + id)
    }
    const canonical = registryPluginId(match[1], match[2] ?? '')
    const allowed = new Set(['source', 'spec', 'profiles', 'requiresBuildApproval', 'requiresRestart', 'manualSteps', 'instructionsUrl'])
    if (Object.keys(value).some(key => !allowed.has(key))) throw new Error('unknown install override field for ' + id)
    if (value.source !== undefined && !['github', 'npm', 'tarball', 'manual'].includes(value.source)) throw new Error('invalid install source for ' + id)
    if (value.spec !== undefined && typeof value.spec !== 'string') throw new Error('invalid install spec for ' + id)
    if (value.profiles !== undefined && (!Array.isArray(value.profiles) || value.profiles.some(profile => typeof profile !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(profile)))) {
      throw new Error('invalid install profiles for ' + id)
    }
    for (const field of ['requiresBuildApproval', 'requiresRestart', 'manualSteps']) {
      if (value[field] !== undefined && typeof value[field] !== 'boolean') throw new Error('invalid ' + field + ' for ' + id)
    }
    if (value.instructionsUrl !== undefined) {
      if (typeof value.instructionsUrl !== 'string' || new URL(value.instructionsUrl).protocol !== 'https:') throw new Error('invalid instructionsUrl for ' + id)
    }
    result.set(canonical.toLocaleLowerCase(), value)
  }
  return result
}

function overridesForRepository(repository) {
  const prefix = repository.toLocaleLowerCase()
  return Object.fromEntries([...installOverrides.entries()]
    .filter(([id]) => id === prefix || id.startsWith(prefix + '&path:/'))
    .sort(([left], [right]) => left.localeCompare(right)))
}

function pathDepth(value) {
  return value.split('/').length
}

function relativePackagePaths(treePaths, packagePath) {
  if (packagePath === '') return [...treePaths]
  const prefix = packagePath + '/'
  return treePaths.filter(value => value.startsWith(prefix)).map(value => value.slice(prefix.length))
}

function joinPackagePath(packagePath, value) {
  const relative = String(value).replace(/^\.\//, '')
  return packagePath === '' ? relative : packagePath + '/' + relative
}

function packageRawUrl(rawBase, packagePath, value) {
  return new URL(rawBase + encodeRawPath(joinPackagePath(packagePath, value)))
}

function suspiciousPackagePath(packagePath) {
  const blocked = new Set(['.dev', '.github', 'test', 'tests', 'fixture', 'fixtures', 'example', 'examples', 'vendor', 'third-party'])
  return packagePath.split('/').some(segment => blocked.has(segment.toLocaleLowerCase()))
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
