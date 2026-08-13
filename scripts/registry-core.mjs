/** Pure validation helpers shared by the Registry scanner and its tests. */

import { parseDocument } from 'yaml'

export const MAX_MANIFEST_BYTES = 256 * 1024
export const MAX_PATCH_BYTES = 64 * 1024
export const MAX_README_BYTES = 256 * 1024
export const INSTALL_CLASSIFIER_VERSION = 5

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
  const lifecycleScripts = plainObject(value.scripts)
    ? ['preinstall', 'install', 'postinstall', 'prepare'].filter(name => typeof value.scripts[name] === 'string')
    : []
  const runtimeEntryGroups = packageRuntimeEntryGroups(value, client !== undefined)
  const marketplace = dsh.marketplace
  let declaredProfiles
  let declaredManualSteps
  let declaredRequiresRestart
  let declaredRequiresBuildApproval
  if (marketplace !== undefined) {
    if (!plainObject(marketplace)) {
      throw new InvalidCandidateError('dsh.marketplace must be an object when declared')
    }
    if (marketplace.profiles !== undefined) {
      if (!Array.isArray(marketplace.profiles)
        || marketplace.profiles.length === 0
        || marketplace.profiles.length > 8
        || marketplace.profiles.some(profile => typeof profile !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(profile))
        || new Set(marketplace.profiles).size !== marketplace.profiles.length) {
        throw new InvalidCandidateError('dsh.marketplace.profiles must contain unique valid profile names')
      }
      declaredProfiles = marketplace.profiles
    }
    for (const field of ['manualSteps', 'requiresRestart', 'requiresBuildApproval']) {
      if (marketplace[field] !== undefined && typeof marketplace[field] !== 'boolean') {
        throw new InvalidCandidateError('dsh.marketplace.' + field + ' must be a boolean')
      }
    }
    declaredManualSteps = marketplace.manualSteps
    declaredRequiresRestart = marketplace.requiresRestart
    declaredRequiresBuildApproval = marketplace.requiresBuildApproval
  }
  return {
    packageName: name,
    version,
    bundlePatch: dsh.bundle.patch,
    hasClient: client !== undefined,
    installHints: {
      declaredProfiles,
      declaredRequiresBuildApproval,
      requiresRestart: declaredRequiresRestart ?? true,
      declaredManualSteps,
      lifecycleScripts,
      runtimeEntryGroups,
    },
  }
}

/**
 * Classify installability from independent static evidence. A prepare script
 * is not sufficient to require a build when the runtime files are committed
 * and the author explicitly documents GitHub installation for this plugin.
 */
export function classifyInstall(identity, repository, treePaths, readmeText, verifiedGitHubRepositories = [repository]) {
  const hints = identity.installHints
  const files = new Set(treePaths.map(normalizeRepoPath))
  const artifactGroups = hints.runtimeEntryGroups.map(group => {
    const found = group.paths.find(candidate => files.has(normalizeRepoPath(candidate))) ?? null
    return { label: group.label, paths: group.paths, found }
  })
  const runtimeArtifactsCommitted = artifactGroups.length > 0 && artifactGroups.every(group => group.found !== null)
  const readme = readmeInstallEvidence(readmeText ?? '', identity.packageName, verifiedGitHubRepositories)
  const fallbackProfiles = identity.hasClient ? ['web'] : []
  const profiles = hints.declaredProfiles ?? (readme.profiles.length > 0 ? readme.profiles : fallbackProfiles)
  const profileSource = hints.declaredProfiles !== undefined
    ? 'manifest'
    : readme.profiles.length > 0
      ? 'readme'
      : identity.hasClient
        ? 'client'
        : 'unknown'
  const hardLifecycleScripts = hints.lifecycleScripts.filter(name => name !== 'prepare')
  const hasPrepare = hints.lifecycleScripts.includes('prepare')
  const prepareNeedsApproval = hasPrepare
    && runtimeArtifactsCommitted
    && !readme.directGitHub
    && hints.declaredRequiresBuildApproval !== false
  const requiresBuildApproval = hardLifecycleScripts.length > 0
    || !runtimeArtifactsCommitted
    || hints.declaredRequiresBuildApproval === true
    || prepareNeedsApproval
  const manualSteps = requiresBuildApproval
    || (hints.declaredManualSteps ?? profiles.length === 0)
  const reviewReasons = []
  const resolvedReasons = []
  if (hasPrepare && runtimeArtifactsCommitted && readme.directGitHub && !requiresBuildApproval) {
    resolvedReasons.push('prepare-present-but-author-documented-github-install-and-runtime-artifacts-are-committed')
  }
  if (readme.directGitHub && !runtimeArtifactsCommitted) {
    reviewReasons.push('readme-documents-github-install-but-runtime-entry-artifacts-are-missing')
  }
  if (hasPrepare && runtimeArtifactsCommitted && !readme.directGitHub && hints.declaredRequiresBuildApproval === undefined) {
    reviewReasons.push('prepare-and-prebuilt-runtime-found-but-readme-does-not-confirm-github-install')
  }
  if (readme.profiles.length > 0 && hints.declaredProfiles !== undefined
    && !sameStringSet(readme.profiles, hints.declaredProfiles)) {
    reviewReasons.push('readme-profiles-conflict-with-dsh-marketplace-profiles')
  }
  if (readme.unverifiedGitHubRepositories.length > 0) {
    reviewReasons.push('readme-github-repository-owner-does-not-resolve-to-this-candidate')
  }
  const requiresManualReview = reviewReasons.length > 0
  return {
    identity: {
      ...identity,
      installHints: {
        profiles,
        requiresBuildApproval,
        requiresRestart: hints.requiresRestart,
        manualSteps: manualSteps || requiresManualReview,
      },
    },
    inspection: {
      classifierVersion: INSTALL_CLASSIFIER_VERSION,
      profileSource,
      profiles,
      lifecycleScripts: hints.lifecycleScripts,
      artifactGroups,
      runtimeArtifactsCommitted,
      readme: {
        found: readmeText !== null,
        directRemote: readme.directRemote,
        directGitHub: readme.directGitHub,
        profiles: readme.profiles,
        specs: readme.specs,
        verifiedGitHubRepositories: [...verifiedGitHubRepositories].sort(),
        unverifiedGitHubRepositories: readme.unverifiedGitHubRepositories,
      },
      reviewReasons,
      resolvedReasons,
    },
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
export function verifiedPlugin(candidate, commit, identity, verifiedAt, installOverride = undefined) {
  const license = plainObject(candidate.license) && typeof candidate.license.spdx_id === 'string'
    ? candidate.license.spdx_id
    : null
  const owner = plainObject(candidate.owner) && typeof candidate.owner.login === 'string'
    ? candidate.owner.login
    : candidate.full_name.split('/')[0]
  const { installHints, ...publicIdentity } = identity
  const githubSpec = 'github:' + candidate.full_name + '#' + commit
  const source = installOverride?.source ?? 'github'
  const profiles = installOverride?.profiles ?? installHints.profiles
  const requiresBuildApproval = installOverride?.requiresBuildApproval ?? installHints.requiresBuildApproval
  const manualSteps = installOverride?.manualSteps ?? installHints.manualSteps
  const requiresRestart = installOverride?.requiresRestart ?? installHints.requiresRestart
  const spec = installOverride?.spec ?? (source === 'github' ? githubSpec : '')
  const automatic = source === 'github'
    && spec.toLocaleLowerCase() === githubSpec.toLocaleLowerCase()
    && profiles.length > 0
    && !requiresBuildApproval
    && !manualSteps
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
    ...publicIdentity,
    install: {
      mode: automatic ? 'automatic' : 'guided',
      source,
      spec,
      profiles,
      requiresBuildApproval,
      requiresRestart,
      manualSteps,
      instructionsUrl: installOverride?.instructionsUrl ?? candidate.html_url + '#readme',
    },
    verifiedAt,
  }
}

/** Refresh mutable GitHub metadata without changing verified identity or commit. */
export function refreshPluginMetadata(plugin, candidate) {
  const license = plainObject(candidate.license) && typeof candidate.license.spdx_id === 'string'
    ? candidate.license.spdx_id
    : null
  const owner = plainObject(candidate.owner) && typeof candidate.owner.login === 'string'
    ? candidate.owner.login
    : candidate.full_name.split('/')[0]
  return {
    ...plugin,
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
    htmlUrl: candidate.html_url,
    topics: Array.isArray(candidate.topics) ? candidate.topics.filter(topic => typeof topic === 'string') : [],
    install: { ...plugin.install, instructionsUrl: candidate.html_url + '#readme' },
  }
}

export function candidateFingerprint(candidate, installOverride = undefined) {
  // Repository metadata such as stars or topics can change `updated_at`
  // without changing plugin files. Code validation only needs a new push or
  // a different default branch to invalidate the previous result.
  return [
    candidate.default_branch,
    candidate.pushed_at,
    JSON.stringify(installOverride ?? null),
    'install-classifier-v' + String(INSTALL_CLASSIFIER_VERSION),
  ].join('\n')
}

export function encodeRawPath(path) {
  return path.split('/').filter(segment => segment !== '.').map(encodeURIComponent).join('/')
}

function packageRuntimeEntryGroups(manifest, hasClient) {
  const groups = []
  const exportsValue = manifest.exports
  let rootExport
  if (typeof exportsValue === 'string' || Array.isArray(exportsValue)) {
    rootExport = exportsValue
  } else if (plainObject(exportsValue)) {
    rootExport = exportsValue['.'] ?? (Object.keys(exportsValue).some(key => key.startsWith('.')) ? undefined : exportsValue)
  }
  const rootPaths = runtimePaths(rootExport)
  if (rootPaths.length === 0 && typeof manifest.main === 'string') rootPaths.push(...runtimePaths(manifest.main))
  if (rootPaths.length === 0) rootPaths.push('index.js', 'index.mjs', 'index.cjs')
  groups.push({ label: 'host', paths: unique(rootPaths) })
  if (hasClient) {
    const clientExport = plainObject(exportsValue) ? exportsValue['./client'] : undefined
    groups.push({ label: 'client', paths: unique(runtimePaths(clientExport)) })
  }
  return groups
}

function runtimePaths(value) {
  if (typeof value === 'string') {
    if (!safePatchPath(value) || value.includes('*')) return []
    const normalized = normalizeRepoPath(value)
    return normalized === '' ? [] : [normalized]
  }
  if (Array.isArray(value)) return value.flatMap(runtimePaths)
  if (!plainObject(value)) return []
  return Object.entries(value)
    .filter(([condition]) => condition !== 'types')
    .flatMap(([, target]) => runtimePaths(target))
}

export function readmeGitHubRepositories(text) {
  const repositories = []
  for (const command of readmeInstallCommands(text)) {
    const repository = githubRepositoryFromSpec(command.spec)
    if (repository !== null && !repositories.some(value => value.toLocaleLowerCase() === repository.toLocaleLowerCase())) {
      repositories.push(repository)
    }
  }
  return repositories
}

function readmeInstallEvidence(text, packageName, verifiedGitHubRepositories) {
  const profiles = new Set()
  const specs = []
  const unverifiedGitHubRepositories = new Set()
  let directRemote = false
  let directGitHub = false
  const allowedRepositories = new Set(verifiedGitHubRepositories.map(value => value.toLocaleLowerCase()))
  const expectedRepositoryNames = new Set(
    verifiedGitHubRepositories.map(value => value.split('/')[1]?.toLocaleLowerCase()).filter(Boolean),
  )
  for (const { profile, spec } of readmeInstallCommands(text)) {
    const github = githubRepositoryFromSpec(spec)
    if (github !== null
      && expectedRepositoryNames.has(github.split('/')[1]?.toLocaleLowerCase())
      && !allowedRepositories.has(github.toLocaleLowerCase())) {
      unverifiedGitHubRepositories.add(github)
    }
    const kind = matchingInstallSpec(spec, packageName, allowedRepositories)
    if (kind === null) continue
    profiles.add(profile)
    directRemote = directRemote || kind === 'github' || kind === 'npm' || kind === 'tarball'
    directGitHub = directGitHub || kind === 'github'
    if (specs.length < 8 && !specs.includes(spec)) specs.push(spec)
  }
  return {
    profiles: [...profiles].sort(),
    specs,
    directRemote,
    directGitHub,
    unverifiedGitHubRepositories: [...unverifiedGitHubRepositories].sort(),
  }
}

function readmeInstallCommands(text) {
  const commands = []
  const expression = /\bdsh\s+plugin\s+--profile(?:\s+|=)(?:"([^"]+)"|'([^']+)'|([^\s`]+))\s+add\s+(?:"([^"]+)"|'([^']+)'|([^\s`]+))/giu
  for (const match of text.matchAll(expression)) {
    const profile = match[1] ?? match[2] ?? match[3] ?? ''
    let spec = match[4] ?? match[5] ?? match[6] ?? ''
    spec = spec.replace(/[),.;]+$/, '')
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(profile)) continue
    commands.push({ profile, spec })
  }
  return commands
}

function matchingInstallSpec(spec, packageName, allowedRepositories) {
  const lower = spec.toLocaleLowerCase()
  const github = githubRepositoryFromSpec(spec)
  if (github !== null) return allowedRepositories.has(github.toLocaleLowerCase()) ? 'github' : null
  if (lower === packageName.toLocaleLowerCase() || lower.startsWith(packageName.toLocaleLowerCase() + '@')) return 'npm'
  if (/^https:\/\/.+\.tgz(?:[?#].*)?$/i.test(spec)) return 'tarball'
  return null
}

function githubRepositoryFromSpec(spec) {
  const github = /^(?:github:|git\+https:\/\/github\.com\/|https:\/\/github\.com\/)([^/#]+)\/([^/#&]+)(?:[&#].*)?$/i.exec(spec)
  if (github === null) return null
  return github[1] + '/' + github[2].replace(/\.git$/i, '')
}

function normalizeRepoPath(value) {
  return String(value).replace(/^\.\//, '').replace(/\\/g, '/')
}

function unique(values) {
  return [...new Set(values)]
}

function sameStringSet(left, right) {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index])
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
