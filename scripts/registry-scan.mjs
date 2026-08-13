/** Discover `dsh-plugin` topic candidates and publish the verified Registry. */

import { readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  InvalidCandidateError,
  MAX_MANIFEST_BYTES,
  MAX_PATCH_BYTES,
  RetryCandidateError,
  candidateFingerprint,
  encodeRawPath,
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

const statePath = path.join(root, 'registry', 'state.json')
const pluginsPath = path.join(root, 'registry', 'plugins.json')
const rejectedPath = path.join(root, 'registry', 'rejected.json')
const denylistPath = path.join(root, 'policy', 'denylist.json')

const previousState = await readJson(statePath)
const denylistDocument = await readJson(denylistPath)
const previous = plainObject(previousState.repositories) ? previousState.repositories : {}
const denylist = new Map((Array.isArray(denylistDocument.repositories) ? denylistDocument.repositories : []).map((entry) => {
  if (typeof entry === 'string') return [entry.toLocaleLowerCase(), 'manually blocked']
  if (plainObject(entry) && typeof entry.repo === 'string') {
    return [entry.repo.toLocaleLowerCase(), typeof entry.reason === 'string' ? entry.reason : 'manually blocked']
  }
  throw new Error('policy/denylist.json contains an invalid repository entry')
}))

console.log('discovering repositories with topic:dsh-plugin')
const candidates = await discoverAll()
console.log('discovered ' + String(candidates.length) + ' candidate repositories')

const next = {}
let validated = 0
let reused = 0
for (const candidate of candidates) {
  const key = candidate.full_name.toLocaleLowerCase()
  const fingerprint = candidateFingerprint(candidate)
  const old = plainObject(previous[key]) ? previous[key] : undefined
  const blockedReason = denylist.get(key)
  if (blockedReason !== undefined) {
    next[key] = stateRow(candidate, fingerprint, 'blocked', blockedReason)
    continue
  }
  if (old !== undefined && sameFingerprint(old.fingerprint, fingerprint) && old.status === 'verified' && plainObject(old.plugin)) {
    next[key] = {
      ...stateRow(candidate, fingerprint, 'verified', null),
      checkedAt: old.checkedAt,
      commit: old.commit,
      plugin: refreshPluginMetadata(old.plugin, candidate),
    }
    reused += 1
    continue
  }
  if (old !== undefined && sameFingerprint(old.fingerprint, fingerprint) && old.status === 'invalid') {
    next[key] = { ...stateRow(candidate, fingerprint, 'invalid', old.reason), checkedAt: old.checkedAt }
    reused += 1
    continue
  }
  try {
    const result = await validateCandidate(candidate)
    next[key] = {
      ...stateRow(candidate, fingerprint, 'verified', null),
      commit: result.commit,
      plugin: result.plugin,
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
  .filter(row => plainObject(row) && row.status === 'verified' && plainObject(row.plugin))
  .map(row => row.plugin)
  .sort((left, right) => left.fullName.localeCompare(right.fullName))
const rejected = Object.values(next)
  .filter(row => plainObject(row) && row.status !== 'verified')
  .map(row => ({
    repository: row.repository,
    status: row.status,
    reason: row.reason,
    checkedAt: row.checkedAt,
  }))
  .sort((left, right) => left.repository.localeCompare(right.repository))

await atomicJson(statePath, { schemaVersion: 1, generatedAt: now, repositories: sortObject(next) })
await atomicJson(pluginsPath, { schemaVersion: 1, generatedAt: now, plugins })
await atomicJson(rejectedPath, { schemaVersion: 1, generatedAt: now, repositories: rejected })
console.log('published ' + String(plugins.length) + ' verified plugins; ' + String(rejected.length) + ' hidden; reused ' + String(reused))

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
  const manifestText = await rawText(new URL(rawBase + 'package.json'), MAX_MANIFEST_BYTES, 'package.json')
  const identity = validateManifest(manifestText)
  const patchText = await rawText(
    new URL(rawBase + encodeRawPath(identity.bundlePatch)),
    MAX_PATCH_BYTES,
    identity.bundlePatch,
  )
  validateBundlePatch(patchText, identity.packageName)
  return { commit, plugin: verifiedPlugin(candidate, commit, identity, now) }
}

async function apiJson(url, candidateRequest = false) {
  let response
  try {
    response = await fetch(url, { headers: apiHeaders, signal: AbortSignal.timeout(20_000) })
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
    response = await fetch(url, { headers: rawHeaders, signal: AbortSignal.timeout(20_000) })
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

/** Accept the previous three-line fingerprint once while migrating it. */
function sameFingerprint(previousFingerprint, currentFingerprint) {
  if (typeof previousFingerprint !== 'string') return false
  return previousFingerprint.split('\n').slice(0, 2).join('\n') === currentFingerprint
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

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
