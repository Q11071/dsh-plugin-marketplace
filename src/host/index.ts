/** Marketplace host service: the `marketplace` Typert Remote namespace.
 *  Search reads the central verified Registry; details and install-time
 *  verification read GitHub. Install/update/uninstall run pnpm jobs in
 *  the profile directory and reconcile the dsh.profile.bundles layer stack
 *  exactly like `dsh plugin add/remove` does. Every method resolves to a
 *  RemoteResult union — business failures carry a typed code, unexpected
 *  throws are folded into the same shape.
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  MarketplaceDetailsRequest,
  MarketplaceInstallRequest,
  MarketplaceInstalled,
  MarketplaceJobStatus,
  MarketplaceJobStatusRequest,
  MarketplaceResult,
  MarketplacePluginDetails,
  MarketplacePluginCategory,
  MarketplaceRegistryPlugin,
  MarketplaceRestartResult,
  MarketplaceSearchPage,
  MarketplaceSearchRequest,
  MarketplaceUninstallRequest,
  MarketplaceToggleRequest,
  MarketplaceToggleResult,
} from '../types.ts'
import { readProfileManifest } from '@deepseek-ai/dsh-app-boot'
import { GitHubClient, GitHubError } from './github.ts'
import { JobTable, runPnpmJob, type JobRecord } from './installer.ts'
import { scheduleProcessRestart } from './restart.ts'
import {
  SELF_BRANCH,
  SELF_PACKAGE,
  SELF_REPOSITORY,
  applySelfUpdate,
  compareSemver,
  selfUpdateTarget,
  type SelfUpdateTarget,
} from './self-update.ts'
import {
  RegistryClient,
  RegistryConfigSchema,
  RegistryError,
  type RegistryConfig,
} from './registry.ts'
import {
  ensureProfile,
  installedEntries,
  installedVersion,
  profileLocation,
  reconcileBundles,
  setBundleEnabled,
  type ProfileLocation,
} from './profile.ts'

const NAME = 'dsh'
const BUNDLED_REGISTRY_URL = new URL('../registry/plugins.json', import.meta.url).href
const DEFAULT_REGISTRY_URL = 'https://raw.githubusercontent.com/YELEBAI/dsh-plugin-marketplace/main/registry/plugins.json'

type Ok<T> = { ok: true; value: T }
type Err = { ok: false; error: { code: string; message: string; details: object } }

function ok<T>(value: T): Ok<T> {
  return { ok: true, value }
}

function fail(code: string, message: string, details: object = {}): Err {
  return { ok: false, error: { code, message, details } }
}

/** Normalize any thrown value into the Remote error branch. */
function toFailure(error: unknown): Err {
  if (error instanceof GitHubError) {
    return fail(error.code, error.message, error.details)
  }
  if (error instanceof RegistryError) {
    return fail(error.code, error.message, error.details)
  }
  const message = error instanceof Error ? error.message : String(error)
  return fail('internal', message, {})
}

export class MarketplaceService extends TypertRemoteService {
  static inject = []
  static Config = RegistryConfigSchema

  private readonly github = new GitHubClient()
  private readonly registry: RegistryClient
  private readonly jobs = new JobTable()
  private selfUpdateCache: { details: MarketplacePluginDetails; target: SelfUpdateTarget; expiresAt: number } | undefined
  private pendingInstallResolution = 0
  private restartPending = false

  constructor(ctx: Context, config: RegistryConfig) {
    super(ctx, 'marketplace')
    const source = config.registryUrl ?? process.env.DSH_PLUGIN_REGISTRY_URL?.trim() ?? DEFAULT_REGISTRY_URL
    // Fail a self-contained URL misconfiguration while the plugin is loading.
    new URL(source)
    this.registry = new RegistryClient(
      source,
      BUNDLED_REGISTRY_URL,
      config.registryCacheMinutes * 60_000,
      config.registryRequestTimeoutMs,
    )
  }

  @Remote('search')
  async search(request: MarketplaceSearchRequest): Promise<MarketplaceResult<MarketplaceSearchPage>> {
    try {
      const page = Number.isInteger(request.page) && request.page >= 1 ? request.page : 1
      const sort = request.sort === 'updated' || request.sort === 'trending' ? request.sort : 'stars'
      const category = request.category === 'all' ? 'all' : request.category as MarketplacePluginCategory
      return ok(await this.registry.search(request.query, page, sort, category))
    } catch (error) {
      return toFailure(error)
    }
  }

  @Remote('details')
  async details(request: MarketplaceDetailsRequest): Promise<MarketplaceResult<MarketplacePluginDetails>> {
    try {
      return ok(await this.github.details(request.repo, request.ref ?? ''))
    } catch (error) {
      return toFailure(error)
    }
  }

  @Remote('installPlugin')
  async installPlugin(request: MarketplaceInstallRequest): Promise<MarketplaceResult<{ jobId: string }>> {
    return this.startJob('install', request.repo, request.ref ?? '', (packageName) => {
      if (this.jobs.activeFor(packageName)) {
        return fail('job-running', 'Another job is already running for ' + packageName + '.')
      }
      return undefined
    })
  }

  @Remote('update')
  async update(request: MarketplaceInstallRequest): Promise<MarketplaceResult<{ jobId: string }>> {
    return this.startJob('update', request.repo, request.ref ?? '', (packageName) => {
      if (this.jobs.activeFor(packageName)) {
        return fail('job-running', 'Another job is already running for ' + packageName + '.')
      }
      return undefined
    })
  }

  @Remote('uninstall')
  async uninstall(request: MarketplaceUninstallRequest): Promise<MarketplaceResult<{ jobId: string }>> {
    try {
      if (this.restartPending) {
        return fail('restart-pending', 'DSH is already preparing to restart.')
      }
      const packageName = request.packageName.trim()
      if (packageName === '' || !/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(packageName)) {
        return fail('bad-package', 'Malformed package name: ' + request.packageName)
      }
      const profile = profileLocation(this.ctx)
      ensureProfile(profile.dir, profile.name)
      if (this.jobs.activeFor(packageName)) {
        return fail('job-running', 'Another job is already running for ' + packageName + '.')
      }
      const before = readProfileManifest(NAME, profile.dir)
      const job = this.jobs.create('uninstall', packageName)
      void this.drive(job, profile, ['remove', packageName], before)
      return ok({ jobId: job.jobId })
    } catch (error) {
      return toFailure(error)
    }
  }

  @Remote('setEnabled')
  async setEnabled(request: MarketplaceToggleRequest): Promise<MarketplaceResult<MarketplaceToggleResult>> {
    try {
      if (this.restartPending) {
        return fail('restart-pending', 'DSH is already preparing to restart.')
      }
      const packageName = request.packageName.trim()
      if (packageName === '' || !/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(packageName)) {
        return fail('bad-package', 'Malformed package name: ' + request.packageName)
      }
      if (this.jobs.activeFor(packageName)) {
        return fail('job-running', 'Another job is already running for ' + packageName + '.')
      }
      const profile = profileLocation(this.ctx)
      ensureProfile(profile.dir, profile.name)
      if (!setBundleEnabled(packageName, request.enabled, profile.dir)) {
        return fail('not-a-dsh-plugin', packageName + ' is not an installed DSH bundle in profile ' + profile.name + '.')
      }
      return ok({ packageName, enabled: request.enabled, requiresRestart: true })
    } catch (error) {
      return toFailure(error)
    }
  }

  @Remote('jobStatus')
  async jobStatus(request: MarketplaceJobStatusRequest): Promise<MarketplaceResult<MarketplaceJobStatus>> {
    const job = this.jobs.get(request.jobId)
    if (job === undefined) {
      return fail('job-missing', 'Unknown job: ' + request.jobId)
    }
    return ok(this.jobs.snapshot(job))
  }

  @Remote('installed')
  async installed(): Promise<MarketplaceResult<MarketplaceInstalled>> {
    try {
      const profile = profileLocation(this.ctx)
      const entries = installedEntries(readProfileManifest(NAME, profile.dir), profile.dir)
      let liveSelf: SelfUpdateTarget | undefined
      if (entries.some(entry => entry.packageName === SELF_PACKAGE)) {
        try {
          liveSelf = (await this.liveSelfUpdate()).target
        } catch {
          // A repository outage must not hide the installed list. The normal
          // Registry lookup below remains available as a conservative fallback.
        }
      }
      await Promise.all(entries.map(async (entry) => {
        if (entry.packageName === SELF_PACKAGE && liveSelf !== undefined) {
          Object.assign(entry, applySelfUpdate(entry, liveSelf, profile.name))
          return
        }
        const registered = await this.registry.findByPackage(entry.packageName)
        if (registered === undefined) return
        entry.registryRepo = registered.fullName
        entry.availableVersion = registered.version
        entry.availableVersionSource = 'registry'
        entry.verifiedCommit = registered.verifiedCommit
        entry.install = registered.install
        const versionOrder = compareSemver(registered.version, entry.version)
        entry.updateAvailable = versionOrder > 0
          || (versionOrder === 0
            && registered.install.source === 'github'
            && isGitHubSpec(entry.currentSpec)
            && !entry.currentSpec.toLocaleLowerCase().includes(registered.verifiedCommit.toLocaleLowerCase()))
        entry.canUpdate = registered.install.mode === 'automatic'
          && (registered.install.source === 'github' || registered.install.source === 'npm')
          && registered.install.profiles.includes(profile.name)
          && registered.install.spec !== ''
      }))
      return ok({ profile: profile.name, entries })
    } catch (error) {
      return toFailure(error)
    }
  }

  @Remote('restart')
  async restart(): Promise<MarketplaceResult<MarketplaceRestartResult>> {
    try {
      if (this.restartPending) {
        return fail('restart-pending', 'DSH is already preparing to restart.')
      }
      if (this.pendingInstallResolution > 0 || this.jobs.hasActive()) {
        return fail('job-running', 'Wait for all plugin install, update, or uninstall jobs to finish before restarting DSH.')
      }
      const profile = profileLocation(this.ctx)
      this.restartPending = true
      try {
        await scheduleProcessRestart()
      } catch (error) {
        this.restartPending = false
        throw error
      }
      return ok({ accepted: true, profile: profile.name })
    } catch (error) {
      return toFailure(error)
    }
  }

  /** Shared install/update pipeline: resolve → gate → spawn detached job. */
  private async startJob(
    kind: 'install' | 'update',
    repo: string,
    ref: string,
    gate: (packageName: string) => Err | undefined,
  ): Promise<MarketplaceResult<{ jobId: string }>> {
    if (this.restartPending) {
      return fail('restart-pending', 'DSH is already preparing to restart.')
    }
    this.pendingInstallResolution += 1
    try {
      const directSelfUpdate = kind === 'update'
        && repo.trim().toLocaleLowerCase() === SELF_REPOSITORY.toLocaleLowerCase()
      let registered: MarketplaceRegistryPlugin | SelfUpdateTarget | undefined
      let details: MarketplacePluginDetails | undefined
      if (directSelfUpdate) {
        const live = await this.liveSelfUpdate(true)
        registered = live.target
        details = live.details
      } else {
        registered = await this.registry.find(repo)
      }
      if (registered === undefined) {
        return fail('not-in-registry', repo + ' is not present in the verified DSH plugin Registry.')
      }
      if (!directSelfUpdate && ref !== '' && ref.toLocaleLowerCase() !== registered.verifiedCommit.toLocaleLowerCase()) {
        return fail('unverified-ref', 'The requested ref is not the commit approved by the DSH plugin Registry.', {
          requestedRef: ref,
          verifiedCommit: registered.verifiedCommit,
        })
      }
      details ??= await this.github.details(registered.fullName, registered.verifiedCommit)
      const manifest = details.manifest
      if (manifest === null || manifest.bundlePatch === null || details.patch === null) {
        return fail(
          'not-a-dsh-plugin',
          details.repo + ' no longer provides the Registry-verified DSH bundle files.',
        )
      }
      if (manifest.name !== registered.packageName || manifest.bundlePatch !== registered.bundlePatch) {
        return fail('registry-mismatch', details.repo + ' no longer matches its verified Registry identity.')
      }
      const packageName = manifest.name
      const gated = gate(packageName)
      if (gated !== undefined) return gated
      const profile = profileLocation(this.ctx)
      ensureProfile(profile.dir, profile.name)
      if (registered.install.mode !== 'automatic'
        || !registered.install.profiles.includes(profile.name)
        || registered.install.spec === '') {
        return fail('guided-install', 'This plugin needs its author\'s guided installation steps.', {
          profile: profile.name,
          supportedProfiles: registered.install.profiles,
          instructionsUrl: registered.install.instructionsUrl,
        })
      }
      const before = readProfileManifest(NAME, profile.dir)
      if (kind === 'install' && before.dependencies?.[packageName] !== undefined) {
        return fail('already-installed', packageName + ' is already installed — use Update instead.')
      }
      if (kind === 'update' && before.dependencies?.[packageName] === undefined) {
        return fail('not-installed', packageName + ' is not installed in profile ' + profile.name + '.')
      }
      const job = this.jobs.create(kind, packageName)
      const spec = executableSpec(registered)
      void this.drive(job, profile, ['add', spec], before, registered.install.requiresRestart)
      return ok({ jobId: job.jobId })
    } catch (error) {
      return toFailure(error)
    } finally {
      this.pendingInstallResolution -= 1
    }
  }

  /** Read main/package.json directly, then freeze the update to its resolved commit. */
  private async liveSelfUpdate(force = false): Promise<{ details: MarketplacePluginDetails; target: SelfUpdateTarget }> {
    if (!force && this.selfUpdateCache !== undefined && Date.now() < this.selfUpdateCache.expiresAt) {
      return this.selfUpdateCache
    }
    const details = await this.github.details(SELF_REPOSITORY, SELF_BRANCH)
    const target = selfUpdateTarget(details)
    const cached = { details, target, expiresAt: Date.now() + 5 * 60_000 }
    this.selfUpdateCache = cached
    return cached
  }

  /** Detached job body: pnpm → reconcile → settle; failures land in the job. */
  private async drive(
    job: JobRecord,
    profile: ProfileLocation,
    args: string[],
    before: ReturnType<typeof readProfileManifest>,
    requiresRestart = true,
  ): Promise<void> {
    try {
      this.jobs.phase(job, 'running')
      const code = await runPnpmJob(job, args, profile.dir, this.jobs)
      if (code !== 0) {
        const hint = code === null
          ? 'pnpm could not be spawned — is pnpm on PATH?'
          : 'pnpm exited with code ' + String(code) + '. See the job log for details.'
        this.jobs.fail(job, { code: 'pnpm-failed', message: hint })
        return
      }
      this.jobs.phase(job, 'reconciling')
      const after = reconcileBundles(before, profile.dir)
      void after
      const version = installedVersion(job.packageName, profile.dir) ?? 'unknown'
      this.jobs.settle(job, { packageName: job.packageName, version, requiresRestart })
    } catch (error) {
      this.jobs.fail(job, {
        code: 'install-failed',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

function executableSpec(plugin: MarketplaceRegistryPlugin | SelfUpdateTarget): string {
  if (plugin.install.source === 'github') {
    const expected = 'github:' + plugin.fullName + '#' + plugin.verifiedCommit
    if (plugin.install.spec.toLocaleLowerCase() !== expected.toLocaleLowerCase()) {
      throw new RegistryError('Registry GitHub install spec does not match the verified repository commit.', {
        repository: plugin.fullName,
      })
    }
    return expected
  }
  if (plugin.install.source === 'npm') {
    const expected = plugin.packageName + '@' + plugin.version
    if (plugin.install.spec !== expected) {
      throw new RegistryError('Registry npm install spec does not match the verified package version.', {
        repository: plugin.fullName,
      })
    }
    return expected
  }
  throw new RegistryError('Only Registry entries pinned to an exact GitHub commit or verified npm release can be installed automatically.')
}

function isGitHubSpec(value: string): boolean {
  return /^(?:github:|git\+https:\/\/github\.com\/|https:\/\/github\.com\/)/i.test(value)
}

export default MarketplaceService
