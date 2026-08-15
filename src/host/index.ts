/** Marketplace host service: the `marketplace` Typert Remote namespace.
 *  Search reads the central verified Registry; details and install-time
 *  verification read GitHub. Install/update/uninstall run pnpm jobs in
 *  the profile directory and reconcile the dsh.profile.bundles layer stack
 *  exactly like `dsh plugin add/remove` does. Every method resolves to a
 *  RemoteResult union — business failures carry a typed code, unexpected
 *  throws are folded into the same shape.
 *
 *  Local fork additions on top of upstream 0.6.1:
 *  - every pnpm job reuses the Profile-linked store (linkedPnpmStore);
 *  - an optional custom install directory with Host-backed picker support;
 *  - static conflict diagnosis (duplicate bundle ids / Cordis services)
 *    with pre-install, pre-enable and manual diagnosis gates;
 *  - unlinked plugin directories are reported and kept out of Profile ops;
 *  - default-mode installs/uninstalls keep manifest + lockfile rollback.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, renameSync, cpSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { ProfileManifest } from '@deepseek-ai/dsh-app-boot'
import type {
  MarketplaceConflict,
  MarketplaceDetailsRequest,
  MarketplaceDiagnoseConflictsResult,
  MarketplaceGuidedAgentRequest,
  MarketplaceGuidedAgentTask,
  MarketplaceInstallLocation,
  MarketplaceInstallRequest,
  MarketplaceInstalled,
  MarketplaceJobStatus,
  MarketplaceJobStatusRequest,
  MarketplacePluginDetails,
  MarketplacePluginCategory,
  MarketplaceRegistryPlugin,
  MarketplaceRestartResult,
  MarketplaceResult,
  MarketplaceSearchPage,
  MarketplaceSearchRequest,
  MarketplaceUninstallRequest,
  MarketplaceToggleRequest,
  MarketplaceToggleResult,
} from '../types.ts'
import { readProfileManifest } from '@deepseek-ai/dsh-app-boot'
import { GitHubClient, GitHubError } from './github.ts'
import { buildGuidedAgentTask } from './guided-agent.ts'
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
  packageManifestPath,
  profileLocation,
  reconcileBundles,
  setBundleEnabled,
  type ProfileLocation,
} from './profile.ts'
import {
  createProfilePackageLink,
  installLocation,
  installedPluginTarget,
  isManagedPluginTarget,
  linkProfilePeerDependencies,
  localDependencySpec,
  marketplaceSettingsPath,
  persistInstallLocation,
  pluginTarget,
  profilePackagePath,
  removePackagePath,
  type ProfileInstallLocation,
} from './install-location.ts'
import { toggleBundleName } from './bundle-state.ts'
import {
  computeConflicts,
  conflictIdentity,
  extractPatchRows,
  extractServiceNames,
  packageEntryPath,
  packagePatchPath,
  readSourceText,
  stagedInstallConflict,
} from './conflicts.ts'

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
  private readonly config: RegistryConfig
  private selfUpdateCache: { details: MarketplacePluginDetails; target: SelfUpdateTarget; expiresAt: number } | undefined
  private pendingInstallResolution = 0
  private restartPending = false

  constructor(ctx: Context, config: RegistryConfig) {
    super(ctx, 'marketplace')
    this.config = config
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

  @Remote('guidedTask')
  async guidedTask(request: MarketplaceGuidedAgentRequest): Promise<MarketplaceResult<MarketplaceGuidedAgentTask>> {
    try {
      const registered = await this.registry.find(request.repo)
      if (registered === undefined) {
        return fail('not-in-registry', request.repo + ' is not present in the verified DSH plugin Registry.')
      }
      if (request.ref.trim().toLocaleLowerCase() !== registered.verifiedCommit.toLocaleLowerCase()) {
        return fail('unverified-ref', 'The guided Agent task must use the exact commit approved by the Registry.', {
          requestedRef: request.ref,
          verifiedCommit: registered.verifiedCommit,
        })
      }
      if (registered.install.mode !== 'guided') {
        return fail('agent-not-required', 'This plugin already has a verified automatic install path.')
      }
      const profile = profileLocation(this.ctx)
      ensureProfile(profile.dir, profile.name)
      if (registered.install.profiles.length > 0 && !registered.install.profiles.includes(profile.name)) {
        return fail('profile-unsupported', 'This plugin is not verified for the current Profile.', {
          profile: profile.name,
          supportedProfiles: registered.install.profiles,
        })
      }
      const evidence = await this.registry.guidedEvidence(registered.fullName)
      if (evidence !== undefined && (
        evidence.packageName !== registered.packageName
        || evidence.version !== registered.version
        || evidence.verifiedCommit.toLocaleLowerCase() !== registered.verifiedCommit.toLocaleLowerCase()
      )) {
        return fail('audit-stale', 'The guided-install audit does not match the current Registry entry. Wait for the next scan before starting an Agent.')
      }
      return ok(buildGuidedAgentTask(registered, profile.name, request.operation, evidence))
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
      const profile = installLocation(this.ctx, this.config)
      ensureProfile(profile.dir, profile.name)
      if (this.jobs.activeFor(packageName)) {
        return fail('job-running', 'Another job is already running for ' + packageName + '.')
      }
      const before = readProfileManifest(NAME, profile.dir)
      const job = this.jobs.create('uninstall', packageName)
      void this.driveUninstall(job, profile, before)
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
      const profile = installLocation(this.ctx, this.config)
      ensureProfile(profile.dir, profile.name)
      if (request.enabled) {
        const manifest = readProfileManifest(NAME, profile.dir)
        const beforeKeys = new Set(computeConflicts(manifest, profile.dir).map(conflictIdentity))
        const bundles = toggleBundleName(manifest.dsh?.profile?.bundles ?? [], packageName, true)
        const prospective = {
          ...manifest,
          dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } },
        }
        const introduced = computeConflicts(prospective, profile.dir)
          .find(conflict => !beforeKeys.has(conflictIdentity(conflict)))
        if (introduced !== undefined) {
          const subject = introduced.kind === 'service'
            ? "service '" + introduced.service + "'"
            : "bundle id '" + introduced.id + "'"
          return fail(
            'plugin-conflict',
            'Enable blocked: ' + subject + ' conflicts with ' + introduced.packages.join(', ') + '. DSH was left unchanged.',
            introduced,
          )
        }
      }
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
      const profile = installLocation(this.ctx, this.config)
      const manifest = readProfileManifest(NAME, profile.dir)
      const entries = installedEntries(manifest, profile.dir, profile.pluginDir)
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
        entry.description = registered.description
        entry.repositoryUrl = registered.htmlUrl
        entry.availableVersion = registered.version
        entry.availableVersionSource = 'registry'
        entry.verifiedCommit = registered.verifiedCommit
        entry.install = registered.install
        if (!entry.linked) {
          entry.updateAvailable = false
          entry.canUpdate = false
          return
        }
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
      let conflicts: MarketplaceConflict[] = []
      try {
        conflicts = computeConflicts(manifest, profile.dir)
      } catch {
        // Diagnosis must never take the whole listing down.
      }
      return ok({
        profile: profile.name,
        installDir: profile.pluginDir,
        installDirCustom: profile.custom,
        entries,
        conflicts,
      })
    } catch (error) {
      return toFailure(error)
    }
  }

  @Remote('installLocation')
  async installLocationRemote(): Promise<MarketplaceResult<MarketplaceInstallLocation>> {
    try {
      const profile = installLocation(this.ctx, this.config)
      return ok({ installDir: profile.pluginDir, installDirCustom: profile.custom })
    } catch (error) {
      return toFailure(error)
    }
  }

  @Remote('setInstallDir')
  async setInstallDir(request: { installDir: string }): Promise<MarketplaceResult<MarketplaceInstallLocation>> {
    try {
      if (this.restartPending) {
        return fail('restart-pending', 'DSH is already preparing to restart.')
      }
      const value = typeof request.installDir === 'string' ? request.installDir.trim() : ''
      const profile = profileLocation(this.ctx)
      return ok(persistInstallLocation(profile.dir, value))
    } catch (error) {
      return toFailure(error)
    }
  }

  @Remote('diagnoseConflicts')
  async diagnoseConflicts(): Promise<MarketplaceResult<MarketplaceDiagnoseConflictsResult>> {
    try {
      const profile = installLocation(this.ctx, this.config)
      const manifest = readProfileManifest(NAME, profile.dir)
      return ok({ conflicts: computeConflicts(manifest, profile.dir), scannedAt: Date.now() })
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

  /** Pre-install conflict check against enabled bundles. Returns a fail() result, or null. */
  private installConflict(details: MarketplacePluginDetails, before: ProfileManifest, dir: string): Err | null {
    const bundles = before.dsh?.profile?.bundles ?? []
    const candidateIds = new Set(extractPatchRows(details.patch ?? '').map(row => row.id).filter(id => id !== ''))
    const existingIds = new Set<string>()
    const serviceOwners = new Map<string, string[]>()
    for (const bundle of bundles) {
      const patchPath = packagePatchPath(bundle, dir)
      if (patchPath === null) continue
      for (const row of extractPatchRows(readSourceText(patchPath))) {
        existingIds.add(row.id)
        const pkg = row.name !== '' ? row.name : bundle
        const entryPath = packageEntryPath(pkg, dir)
        if (entryPath === null) continue
        for (const service of extractServiceNames(readSourceText(entryPath))) {
          const list = serviceOwners.get(service) ?? []
          list.push(pkg)
          serviceOwners.set(service, list)
        }
      }
    }
    for (const id of candidateIds) {
      if (existingIds.has(id)) {
        return fail('plugin-conflict', "Install blocked: bundle id '" + id + "' is already registered by an enabled plugin. Disable the conflicting plugin first.", { kind: 'duplicate-id', id })
      }
    }
    for (const service of extractServiceNames(details.entrySource ?? '')) {
      const owners = serviceOwners.get(service)
      if (owners !== undefined && owners.length > 0) {
        return fail('plugin-conflict', "Install blocked: service '" + service + "' is already provided by " + [...new Set(owners)].join(', ') + '. Enabling both plugins would crash DSH at startup.', { kind: 'service', service, packages: [...new Set(owners)] })
      }
    }
    return null
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
      const profile = installLocation(this.ctx, this.config)
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
      const target = profile.custom
        ? (kind === 'update' ? installedPluginTarget(profile, packageName, before) : pluginTarget(profile, packageName))
        : profilePackagePath(profile.dir, packageName)
      if (kind === 'install' && existsSync(target)) {
        return fail('plugin-dir-exists', 'Install blocked: target directory already exists: ' + target, { target })
      }
      if (kind === 'update' && existsSync(target)) {
        try {
          const targetManifest = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')) as { name?: unknown }
          if (targetManifest.name !== packageName) {
            return fail('plugin-dir-conflict', 'Update blocked: ' + target + ' belongs to ' + String(targetManifest.name ?? 'another package') + '.', { target })
          }
        } catch (error) {
          return fail('plugin-dir-invalid', 'Update blocked: cannot validate existing plugin directory ' + target + '.', { target, cause: error instanceof Error ? error.message : String(error) })
        }
      }
      if (kind === 'install') {
        const conflict = this.installConflict(details, before, profile.dir)
        if (conflict !== null) return conflict
      }
      const job = this.jobs.create(kind, packageName)
      const spec = executableSpec(registered)
      void this.driveInstall(job, profile, spec, before, registered.install.requiresRestart)
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

  /** Custom-directory install: staging download → conflict check → copy → link. */
  private async driveInstall(
    job: JobRecord,
    profile: ProfileInstallLocation,
    spec: string,
    before: ProfileManifest,
    requiresRestart = true,
  ): Promise<void> {
    if (!profile.custom) {
      await this.driveProfileInstall(job, profile, spec, before, requiresRestart)
      return
    }
    const stageDir = join(dirname(marketplaceSettingsPath()), 'staging', job.jobId)
    const target = pluginTarget(profile, job.packageName)
    const backup = target + '.marketplace-backup-' + job.jobId
    const manifestPath = join(profile.dir, 'package.json')
    const originalManifest = readFileSync(manifestPath, 'utf8')
    let targetWritten = false
    let backupCreated = false
    let manifestWritten = false
    let lockfileWritten = false
    let profilePackageState: { linkPath: string; backupPath: string; backupCreated: boolean } | null = null
    try {
      this.jobs.phase(job, 'running')
      mkdirSync(stageDir, { recursive: true })
      writeFileSync(join(stageDir, 'package.json'), JSON.stringify({ private: true }, null, 2) + '\n', 'utf8')
      let code = await runPnpmJob(job, ['add', spec, '--ignore-scripts'], stageDir, this.jobs, profile.storeDir)
      if (code !== 0) throw new Error(code === null ? 'pnpm could not be spawned — is pnpm on PATH?' : 'Plugin download failed: pnpm exited with code ' + String(code) + '.')
      const stagedManifest = packageManifestPath(job.packageName, stageDir)
      if (stagedManifest === null) throw new Error('Downloaded package ' + job.packageName + ' could not be found in staging.')
      const conflict = stagedInstallConflict(job.packageName, stageDir, before, profile.dir)
      if (conflict !== null) throw new Error(conflict.message)
      mkdirSync(profile.pluginDir, { recursive: true })
      if (existsSync(target)) {
        renameSync(target, backup)
        backupCreated = true
      }
      cpSync(dirname(stagedManifest), target, {
        recursive: true,
        dereference: true,
        filter: (source) => basename(source) !== 'node_modules',
      })
      targetWritten = true
      const copiedManifest = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')) as { name?: unknown }
      if (copiedManifest.name !== job.packageName) throw new Error('Downloaded package identity mismatch: expected ' + job.packageName + '.')
      this.jobs.append(job, 'Installing dependencies inside the plugin directory.\n')
      code = await runPnpmJob(job, ['install', '--prod', '--ignore-scripts'], target, this.jobs, profile.storeDir)
      if (code !== 0) throw new Error(code === null ? 'pnpm could not be spawned — is pnpm on PATH?' : 'Plugin dependency install failed: pnpm exited with code ' + String(code) + '.')
      const linkedPeers = linkProfilePeerDependencies(target, profile.dir)
      if (linkedPeers.length > 0) this.jobs.append(job, 'Linked DSH host dependencies: ' + linkedPeers.join(', ') + '\n')
      const manifest = JSON.parse(originalManifest) as ProfileManifest
      manifest.dependencies = manifest.dependencies ?? {}
      manifest.dependencies[job.packageName] = localDependencySpec(profile.dir, target)
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
      manifestWritten = true
      code = await runPnpmJob(job, ['install', '--lockfile-only', '--ignore-scripts'], profile.dir, this.jobs, profile.storeDir)
      if (code !== 0) throw new Error(code === null ? 'pnpm could not be spawned — is pnpm on PATH?' : 'Profile lockfile update failed: pnpm exited with code ' + String(code) + '.')
      lockfileWritten = true
      profilePackageState = createProfilePackageLink(profile.dir, job.packageName, target, job.jobId)
      this.jobs.phase(job, 'reconciling')
      reconcileBundles(before, profile.dir)
      const version = installedVersion(job.packageName, profile.dir) ?? 'unknown'
      this.jobs.settle(job, { packageName: job.packageName, version, requiresRestart })
      if (backupCreated) rmSync(backup, { recursive: true, force: true })
      if (profilePackageState.backupCreated) removePackagePath(profilePackageState.backupPath)
    } catch (error) {
      if (profilePackageState !== null) {
        removePackagePath(profilePackageState.linkPath)
        if (profilePackageState.backupCreated && existsSync(profilePackageState.backupPath)) {
          renameSync(profilePackageState.backupPath, profilePackageState.linkPath)
        }
      }
      if (manifestWritten) writeFileSync(manifestPath, originalManifest, 'utf8')
      if (targetWritten) rmSync(target, { recursive: true, force: true })
      if (backupCreated && existsSync(backup)) renameSync(backup, target)
      if (lockfileWritten) {
        this.jobs.append(job, 'Rolling back the profile lockfile.\n')
        const rollbackCode = await runPnpmJob(job, ['install', '--lockfile-only', '--ignore-scripts'], profile.dir, this.jobs, profile.storeDir)
        if (rollbackCode !== 0) this.jobs.append(job, 'Warning: automatic lockfile rollback did not complete.\n')
      }
      this.jobs.fail(job, {
        code: 'install-failed',
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      rmSync(stageDir, { recursive: true, force: true })
    }
  }

  /** Default mode: pnpm manages the Profile directly, with rollback. */
  private async driveProfileInstall(
    job: JobRecord,
    profile: ProfileInstallLocation,
    spec: string,
    before: ProfileManifest,
    requiresRestart = true,
  ): Promise<void> {
    const stageDir = join(dirname(marketplaceSettingsPath()), 'staging', job.jobId)
    const manifestPath = join(profile.dir, 'package.json')
    const lockfilePath = join(profile.dir, 'pnpm-lock.yaml')
    const originalManifest = readFileSync(manifestPath, 'utf8')
    const originalLockfile = existsSync(lockfilePath) ? readFileSync(lockfilePath, 'utf8') : null
    let profileAttempted = false
    try {
      this.jobs.phase(job, 'running')
      mkdirSync(stageDir, { recursive: true })
      writeFileSync(join(stageDir, 'package.json'), JSON.stringify({ private: true }, null, 2) + '\n', 'utf8')
      let code = await runPnpmJob(job, ['add', spec, '--ignore-scripts'], stageDir, this.jobs, profile.storeDir)
      if (code !== 0) throw new Error(code === null ? 'pnpm could not be spawned — is pnpm on PATH?' : 'Plugin download failed: pnpm exited with code ' + String(code) + '.')
      const stagedManifest = packageManifestPath(job.packageName, stageDir)
      if (stagedManifest === null) throw new Error('Downloaded package ' + job.packageName + ' could not be found in staging.')
      const conflict = stagedInstallConflict(job.packageName, stageDir, before, profile.dir)
      if (conflict !== null) throw new Error(conflict.message)
      profileAttempted = true
      code = await runPnpmJob(job, ['add', spec, '--ignore-scripts'], profile.dir, this.jobs, profile.storeDir)
      if (code !== 0) throw new Error(code === null ? 'pnpm could not be spawned — is pnpm on PATH?' : 'Profile install failed: pnpm exited with code ' + String(code) + '.')
      this.jobs.phase(job, 'reconciling')
      reconcileBundles(before, profile.dir)
      const version = installedVersion(job.packageName, profile.dir) ?? 'unknown'
      this.jobs.settle(job, { packageName: job.packageName, version, requiresRestart })
    } catch (error) {
      if (profileAttempted) {
        writeFileSync(manifestPath, originalManifest, 'utf8')
        if (originalLockfile === null) rmSync(lockfilePath, { force: true })
        else writeFileSync(lockfilePath, originalLockfile, 'utf8')
        this.jobs.append(job, 'Rolling back the Profile dependency state.\n')
        const rollbackCode = await runPnpmJob(job, ['install', '--ignore-scripts'], profile.dir, this.jobs, profile.storeDir)
        if (rollbackCode !== 0) this.jobs.append(job, 'Warning: automatic Profile rollback did not complete.\n')
      }
      this.jobs.fail(job, {
        code: 'install-failed',
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      rmSync(stageDir, { recursive: true, force: true })
    }
  }

  /** Custom-directory uninstall: remove the Profile link, then the managed entity. */
  private async driveUninstall(
    job: JobRecord,
    profile: ProfileInstallLocation,
    before: ProfileManifest,
    requiresRestart = true,
  ): Promise<void> {
    if (!profile.custom) {
      await this.driveProfileUninstall(job, profile, before, requiresRestart)
      return
    }
    const manifestPath = join(profile.dir, 'package.json')
    const originalManifest = readFileSync(manifestPath, 'utf8')
    let manifestWritten = false
    try {
      this.jobs.phase(job, 'running')
      const spec = before.dependencies?.[job.packageName]
      const target = installedPluginTarget(profile, job.packageName, before)
      const managedTarget = typeof spec === 'string' && spec.startsWith('file:') && isManagedPluginTarget(profile, job.packageName, target)
      const next = JSON.parse(originalManifest) as ProfileManifest
      if (next.dependencies !== undefined) delete next.dependencies[job.packageName]
      const bundles = next.dsh?.profile?.bundles ?? []
      next.dsh = { ...next.dsh, profile: { ...next.dsh?.profile, bundles: bundles.filter(name => name !== job.packageName) } }
      writeFileSync(manifestPath, JSON.stringify(next, null, 2) + '\n', 'utf8')
      manifestWritten = true
      const code = await runPnpmJob(job, ['install', '--lockfile-only', '--ignore-scripts'], profile.dir, this.jobs, profile.storeDir)
      if (code !== 0) throw new Error(code === null ? 'pnpm could not be spawned — is pnpm on PATH?' : 'Profile unlink failed: pnpm exited with code ' + String(code) + '.')
      this.jobs.phase(job, 'reconciling')
      try {
        removePackagePath(profilePackagePath(profile.dir, job.packageName))
      } catch (error) {
        this.jobs.append(job, 'Warning: the old runtime package could not be removed until DSH restarts: ' + (error instanceof Error ? error.message : String(error)) + '\n')
      }
      if (managedTarget && existsSync(target)) rmSync(target, { recursive: true, force: true })
      this.jobs.settle(job, { packageName: job.packageName, version: 'removed', requiresRestart })
    } catch (error) {
      if (manifestWritten) {
        writeFileSync(manifestPath, originalManifest, 'utf8')
        this.jobs.append(job, 'Rolling back the profile lockfile.\n')
        const rollbackCode = await runPnpmJob(job, ['install', '--lockfile-only', '--ignore-scripts'], profile.dir, this.jobs, profile.storeDir)
        if (rollbackCode !== 0) this.jobs.append(job, 'Warning: automatic lockfile rollback did not complete.\n')
      }
      this.jobs.fail(job, {
        code: 'uninstall-failed',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** Default mode: pnpm remove, with manifest + lockfile rollback. */
  private async driveProfileUninstall(
    job: JobRecord,
    profile: ProfileInstallLocation,
    before: ProfileManifest,
    requiresRestart = true,
  ): Promise<void> {
    const manifestPath = join(profile.dir, 'package.json')
    const lockfilePath = join(profile.dir, 'pnpm-lock.yaml')
    const originalManifest = readFileSync(manifestPath, 'utf8')
    const originalLockfile = existsSync(lockfilePath) ? readFileSync(lockfilePath, 'utf8') : null
    try {
      this.jobs.phase(job, 'running')
      const code = await runPnpmJob(job, ['remove', job.packageName], profile.dir, this.jobs, profile.storeDir)
      if (code !== 0) throw new Error(code === null ? 'pnpm could not be spawned — is pnpm on PATH?' : 'Profile uninstall failed: pnpm exited with code ' + String(code) + '.')
      this.jobs.phase(job, 'reconciling')
      reconcileBundles(before, profile.dir)
      this.jobs.settle(job, { packageName: job.packageName, version: 'removed', requiresRestart })
    } catch (error) {
      writeFileSync(manifestPath, originalManifest, 'utf8')
      if (originalLockfile === null) rmSync(lockfilePath, { force: true })
      else writeFileSync(lockfilePath, originalLockfile, 'utf8')
      this.jobs.append(job, 'Rolling back the Profile dependency state.\n')
      const rollbackCode = await runPnpmJob(job, ['install', '--ignore-scripts'], profile.dir, this.jobs, profile.storeDir)
      if (rollbackCode !== 0) this.jobs.append(job, 'Warning: automatic Profile rollback did not complete.\n')
      this.jobs.fail(job, {
        code: 'uninstall-failed',
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
