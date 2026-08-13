/** Pure validation helpers shared by the Registry scanner and its tests. */

import { parseDocument } from 'yaml'

export const MAX_MANIFEST_BYTES = 256 * 1024
export const MAX_PATCH_BYTES = 64 * 1024

/** Candidate is structurally not a DSH bundle. */
export class InvalidCandidateError extends Error {
  constructor(message) {
    super(message)
    this.name = 'InvalidCandidateError'
  }
}

/** Network or service failure that must be retried instead of rejecting a repository. */
export class RetryCandidateError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RetryCandidateError'
  }
}

/** A bundle patch path must stay inside the repository root. */
export function safePatchPath(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 240
    && !value.startsWith('/')
    && !value.includes('\\')
    && !value.includes('\0')
    && !value.split('/').includes('..')
    && !/^[a-z][a-z\d+.-]*:/i.test(value)
}

/** Validate package metadata and return the Registry identity fields. */
export function validateManifest(text) {
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new InvalidCandidateError('package.json is not valid JSON')
  }
  if (!plainObject(value)) throw new InvalidCandidateError('package.json must contain an object')
  const name = value.name
  if (typeof name !== 'string' || !/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(name)) {
    throw new InvalidCandidateError('package.json has no valid lowercase npm package name')
  }
  const version = value.version
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new InvalidCandidateError('package.json has no valid semantic version')
  }
  const dsh = value.dsh
  if (!plainObject(dsh) || !plainObject(dsh.bundle) || !safePatchPath(dsh.bundle.patch)) {
    throw new InvalidCandidateError('package.json does not declare a safe dsh.bundle.patch')
  }
  const client = dsh.client
  if (client !== undefined) {
    if (!plainObject(client) || client.platform !== 'web') {
      throw new InvalidCandidateError('dsh.client must declare platform "web"')
    }
    if (!plainObject(value.exports) || value.exports['./client'] === undefined) {
      throw new InvalidCandidateError('dsh.client requires a ./client package export')
    }
  }
  return {
    packageName: name,
    version,
    bundlePatch: dsh.bundle.patch,
    hasClient: client !== undefined,
  }
}

const jsScalarTag = {
  tag: 'tag:yaml.org,2002:js',
  resolve(value) { return String(value) },
}

/** Parse a bundle patch as data and prove that it inserts its owning package. */
export function validateBundlePatch(text, packageName) {
  const document = parseDocument(text, {
    customTags: [jsScalarTag],
    maxAliasCount: 50,
    prettyErrors: false,
    schema: 'core',
    strict: true,
    uniqueKeys: true,
  })
  const issues = [...document.errors, ...document.warnings]
  if (issues.length > 0) {
    throw new InvalidCandidateError('bundle patch is invalid YAML: ' + issues[0].message)
  }
  let root
  try {
    root = document.toJS({ maxAliasCount: 50 })
  } catch (error) {
    throw new InvalidCandidateError('bundle patch could not be materialized: ' + messageOf(error))
  }
  if (!Array.isArray(root) || root.length === 0) {
    throw new InvalidCandidateError('bundle patch must be a non-empty operation array')
  }
  let ownsEntry = false
  for (const operation of root) {
    if (!plainObject(operation)) throw new InvalidCandidateError('every bundle patch operation must be an object')
    if (operation.insert === undefined) continue
    if (!Array.isArray(operation.insert)) throw new InvalidCandidateError('bundle patch insert must be an array')
    for (const entry of operation.insert) {
      if (!plainObject(entry) || typeof entry.id !== 'string' || entry.id === '' || typeof entry.name !== 'string') {
        throw new InvalidCandidateError('every inserted loader entry needs non-empty id and name fields')
      }
      if (entry.name === packageName) ownsEntry = true
    }
  }
  if (!ownsEntry) {
    throw new InvalidCandidateError('bundle patch does not insert a loader entry owned by package ' + packageName)
  }
}

/** Construct the public Registry row after both files passed. */
export function verifiedPlugin(candidate, commit, identity, verifiedAt) {
  const license = plainObject(candidate.license) && typeof candidate.license.spdx_id === 'string'
    ? candidate.license.spdx_id
    : null
  const owner = plainObject(candidate.owner) && typeof candidate.owner.login === 'string'
    ? candidate.owner.login
    : candidate.full_name.split('/')[0]
  return {
    owner,
    repo: candidate.name,
    fullName: candidate.full_name,
    description: typeof candidate.description === 'string' ? candidate.description : null,
    stars: integer(candidate.stargazers_count),
    forks: integer(candidate.forks_count),
    openIssues: integer(candidate.open_issues_count),
    language: typeof candidate.language === 'string' ? candidate.language : null,
    license,
    updatedAt: iso(candidate.updated_at),
    defaultBranch: candidate.default_branch,
    verifiedCommit: commit,
    htmlUrl: candidate.html_url,
    topics: Array.isArray(candidate.topics) ? candidate.topics.filter(topic => typeof topic === 'string') : [],
    ...identity,
    verifiedAt,
  }
}

/** Refresh mutable GitHub metadata without changing verified identity or commit. */
export function refreshPluginMetadata(plugin, candidate) {
  return {
    ...verifiedPlugin(candidate, plugin.verifiedCommit, {
      packageName: plugin.packageName,
      version: plugin.version,
      bundlePatch: plugin.bundlePatch,
      hasClient: plugin.hasClient,
    }, plugin.verifiedAt),
  }
}

export function candidateFingerprint(candidate) {
  // Repository metadata such as stars or topics can change `updated_at`
  // without changing plugin files. Code validation only needs a new push or
  // a different default branch to invalidate the previous result.
  return [candidate.default_branch, candidate.pushed_at].join('\n')
}

export function encodeRawPath(path) {
  return path.split('/').filter(segment => segment !== '.').map(encodeURIComponent).join('/')
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function integer(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

function iso(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : new Date(0).toISOString()
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
