/** Shared JSON vocabulary crossing the marketplace Remote boundary.
 *  Both the host service and the client tab import these shapes; nothing
 *  here carries runtime identity, so both bundles may inline their own copy.
 */

/** Marketplace business failure carried inside a successful Remote transport. */
export interface MarketplaceFailure {
  code: string
  message: string
  details: object
}

/** Business outcome kept separate from the Remote transport result. */
export type MarketplaceResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: MarketplaceFailure }

/** GitHub API rate-limit projection (core vs. search pool). */
export interface MarketplaceRateLimit {
  limit: number
  remaining: number
  /** Epoch seconds when the window resets. */
  reset: number
  source: 'core' | 'search'
}

/** One search-result repository row. */
export interface MarketplaceRepoSummary {
  owner: string
  repo: string
  fullName: string
  description: string | null
  stars: number
  forks: number
  openIssues: number
  language: string | null
  license: string | null
  updatedAt: string
  defaultBranch: string
  /** Immutable commit that passed the central Registry validation. */
  verifiedCommit: string
  htmlUrl: string
  topics: string[]
}

/** One centrally verified plugin published by the Registry. */
export interface MarketplaceRegistryPlugin extends MarketplaceRepoSummary {
  packageName: string
  version: string
  bundlePatch: string
  hasClient: boolean
  verifiedAt: string
}

/** Signed-content payload before an optional detached signature is added. */
export interface MarketplaceRegistry {
  schemaVersion: 1
  generatedAt: string
  plugins: MarketplaceRegistryPlugin[]
}

/** plugin.json-relevant manifest facts read from the repo at one ref. */
export interface MarketplacePluginManifest {
  name: string
  version: string
  description: string
  license: string | null
  /** dsh.bundle.patch value when declared (the plugin identity contract). */
  bundlePatch: string | null
  hasClient: boolean
}

/** details() outcome: manifest + bundle patch text for pre-install review. */
export interface MarketplacePluginDetails {
  repo: string
  /** Ref the caller asked for ('' means auto-select). */
  ref: string
  /** Concrete ref used for the raw fetch. */
  resolvedRef: string
  manifest: MarketplacePluginManifest | null
  /** Bundle patch text, capped at 64 KiB, when the manifest declares one. */
  patch: string | null
  readmeUrl: string
  rate: MarketplaceRateLimit
}

/** One search page. */
export interface MarketplaceSearchPage {
  totalCount: number
  items: MarketplaceRepoSummary[]
  rate: MarketplaceRateLimit
}

export type MarketplaceJobKind = 'install' | 'update' | 'uninstall'
export type MarketplaceJobPhase = 'spawning' | 'running' | 'reconciling' | 'done' | 'failed'

/** Live projection of one install/uninstall/update job (polled). */
export interface MarketplaceJobStatus {
  jobId: string
  kind: MarketplaceJobKind
  packageName: string
  phase: MarketplaceJobPhase
  /** Incremental pnpm output, capped at 64 KiB (tail). */
  log: string
  exitCode: number | null
  startedAt: number
  finishedAt: number | null
  outcome: { packageName: string; version: string; requiresRestart: boolean } | null
  failure: { code: string; message: string } | null
}

/** One row of the installed() listing. */
export interface MarketplaceInstalledEntry {
  packageName: string
  version: string
  /** Whether the profile bundle layer stack includes this package. */
  isBundle: boolean
}

export interface MarketplaceInstalled {
  entries: MarketplaceInstalledEntry[]
}

/** Job identity returned when an install, update, or uninstall starts. */
export interface MarketplaceJobHandle {
  jobId: string
}

export type MarketplaceSearchOutcome = MarketplaceResult<MarketplaceSearchPage>
export type MarketplaceDetailsOutcome = MarketplaceResult<MarketplacePluginDetails>
export type MarketplaceInstallOutcome = MarketplaceResult<MarketplaceJobHandle>
export type MarketplaceJobStatusOutcome = MarketplaceResult<MarketplaceJobStatus>
export type MarketplaceInstalledOutcome = MarketplaceResult<MarketplaceInstalled>

export interface MarketplaceSearchRequest {
  query: string
  page: number
  sort: 'stars' | 'updated'
}

export interface MarketplaceDetailsRequest {
  /** owner/repo */
  repo: string
  /** Exact tag, or '' for auto (latest release, then default branch). */
  ref: string
}

export interface MarketplaceInstallRequest {
  repo: string
  ref: string
}

export interface MarketplaceJobStatusRequest {
  jobId: string
}

export interface MarketplaceUninstallRequest {
  packageName: string
}
