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
  MarketplaceRegistryPlugin,
  MarketplaceSearchPage,
  MarketplaceSearchRequest,
  MarketplaceUninstallRequest,
} from '../types.ts'
import { readProfileManifest } from '@deepseek-ai/dsh-app-boot'
import { GitHubClient, GitHubError } from './github.ts'
import { JobTable, runPnpmJob, type JobRecord } from './installer.ts'
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
      const sort = request.sort === 'updated' ? 'updated' : 'stars'
      return ok(await this.registry.search(request.query, page, sort))
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
      await Promise.all(entries.map(async (entry) => {
        const registered = await this.registry.findByPackage(entry.packageName)
        if (registered === undefined) return
        entry.registryRepo = registered.fullName
        entry.availableVersion = registered.version
        entry.verifiedCommit = registered.verifiedCommit
        entry.install = registered.install
        const versionOrder = compareSemver(registered.version, entry.version)
        entry.updateAvailable = versionOrder > 0
          || (versionOrder === 0
            && registered.install.source === 'github'
            && isGitHubSpec(entry.currentSpec)
            && !entry.currentSpec.toLocaleLowerCase().includes(registered.verifiedCommit.toLocaleLowerCase()))
        entry.canUpdate = registered.install.mode === 'automatic'
          && registered.install.source === 'github'
          && registered.install.profiles.includes(profile.name)
          && registered.install.spec !== ''
      }))
      return ok({ profile: profile.name, entries })
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
    try {
      const registered = await this.registry.find(repo)
      if (registered === undefined) {
        return fail('not-in-registry', repo + ' is not present in the verified DSH plugin Registry.')
      }
      if (ref !== '' && ref.toLocaleLowerCase() !== registered.verifiedCommit.toLocaleLowerCase()) {
        return fail('unverified-ref', 'The requested ref is not the commit approved by the DSH plugin Registry.', {
          requestedRef: ref,
          verifiedCommit: registered.verifiedCommit,
        })
      }
      const details = await this.github.details(registered.fullName, registered.verifiedCommit)
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
    }
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

function executableSpec(plugin: MarketplaceRegistryPlugin): string {
  if (plugin.install.source === 'github') {
    const expected = 'github:' + plugin.fullName + '#' + plugin.verifiedCommit
    if (plugin.install.spec.toLocaleLowerCase() !== expected.toLocaleLowerCase()) {
      throw new RegistryError('Registry GitHub install spec does not match the verified repository commit.', {
        repository: plugin.fullName,
      })
    }
    return expected
  }
  throw new RegistryError('Only Registry entries pinned to an exact GitHub commit can be installed automatically.')
}

function isGitHubSpec(value: string): boolean {
  return /^(?:github:|git\+https:\/\/github\.com\/|https:\/\/github\.com\/)/i.test(value)
}

/** Compare semver values without introducing a runtime dependency into the host bundle. */
function compareSemver(left: string, right: string): number {
  const parse = (value: string): { core: [number, number, number]; prerelease: string[] } | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value)
    if (match === null) return null
    return {
      core: [Number(match[1]), Number(match[2]), Number(match[3])],
      prerelease: match[4]?.split('.') ?? [],
    }
  }
  const a = parse(left)
  const b = parse(right)
  if (a === null || b === null) return left === right ? 0 : -1
  for (let index = 0; index < 3; index += 1) {
    const av = a.core[index]!
    const bv = b.core[index]!
    if (av !== bv) return av > bv ? 1 : -1
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0
    return a.prerelease.length === 0 ? 1 : -1
  }
  const maximum = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < maximum; index += 1) {
    const av = a.prerelease[index]
    const bv = b.prerelease[index]
    if (av === undefined || bv === undefined) return av === undefined ? -1 : 1
    if (av === bv) continue
    const an = /^\d+$/.test(av)
    const bn = /^\d+$/.test(bv)
    if (an && bn) return Number(av) > Number(bv) ? 1 : -1
    if (an !== bn) return an ? -1 : 1
    return av.localeCompare(bv) > 0 ? 1 : -1
  }
  return 0
}


export default MarketplaceService
