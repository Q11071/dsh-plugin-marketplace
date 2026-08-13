/** Profile-directory resolution and bundle-layer reconciliation.
 *  Mirrors `dsh plugin` semantics (apps/cli/src/plugin.ts): pnpm manages
 *  the profile directory, and a dependency that declares dsh.bundle.patch
 *  joins the dsh.profile.bundles layer stack after every install/update.
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import {
  DEFAULT_PROFILE_BUNDLES,
  PROFILE_TEMPLATES,
  initProfile,
  readProfileManifest,
  resolveProfileDir,
  writeProfileManifest,
  type ProfileManifest,
} from '@deepseek-ai/dsh-app-boot'
import type { MarketplaceInstalledEntry } from '../types.ts'

const NAME = 'dsh'

export interface ProfileLocation {
  dir: string
  name: string
}

/**
 * The profile this plugin runs inside. The Loader's baseUrl is the config
 * tree directory — for a `dsh --profile <name>` launch that IS the profile
 * directory (the same anchor client-modules and typert-loader use). It may
 * arrive as a file:// URL string or a URL object, never as a bare path.
 * A file anchor pointing at cordis.yml resolves to its directory; anything
 * else falls back to the standard `web` profile location.
 */
export function profileLocation(ctx: Context): ProfileLocation {
  const baseUrl = ctx.baseUrl
  if (baseUrl !== undefined) {
    let raw: string
    if (typeof baseUrl === 'string') {
      raw = /^[a-z][a-z0-9+.-]*:/.test(baseUrl) ? fileURLToPath(new URL(baseUrl)) : baseUrl
    } else {
      raw = fileURLToPath(baseUrl)
    }
    const dir = /\.(yml|yaml|json)$/.test(basename(raw)) ? dirname(raw) : raw
    const name = basename(dir)
    if (name !== '' && name !== '.' && name !== '..') return { dir, name }
  }
  const fallback = 'web'
  return { dir: resolveProfileDir(fallback), name: fallback }
}

/** Initialize the profile directory when it does not exist yet. */
export function ensureProfile(dir: string, name: string): void {
  if (!existsSync(join(dir, 'package.json'))) {
    initProfile(dir, PROFILE_TEMPLATES[name] ?? DEFAULT_PROFILE_BUNDLES)
  }
}

/** Resolve an installed dependency's package.json from the profile directory. */
function packageManifestPath(packageName: string, dir: string): string | null {
  try {
    const require = createRequire(join(dir, 'package.json'))
    return require.resolve(packageName + '/package.json')
  } catch {
    return null
  }
}

/** Whether an installed dependency declares dsh.bundle.patch (i.e. is a bundle). */
export function exportsPatch(packageName: string, dir: string): boolean {
  const path = packageManifestPath(packageName, dir)
  if (path === null) return false
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const dsh = manifest.dsh as Record<string, unknown> | undefined
    const bundle = dsh?.bundle as Record<string, unknown> | undefined
    return typeof bundle?.patch === 'string'
  } catch {
    return false
  }
}

/** Installed version of one dependency, or null when unresolvable. */
export function installedVersion(packageName: string, dir: string): string | null {
  const path = packageManifestPath(packageName, dir)
  if (path === null) return null
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : null
  } catch {
    return null
  }
}

/**
 * Reconcile dsh.profile.bundles against the installed state after pnpm
 * already wrote the real package names into the profile manifest. New
 * bundle-declaring dependencies join the layer stack; dependency-managed
 * entries whose package no longer declares a bundle leave it.
 */
export function reconcileBundles(before: ProfileManifest, dir: string): ProfileManifest {
  const after = readProfileManifest(NAME, dir)
  const beforeDeps = new Set(Object.keys(before.dependencies ?? {}))
  const dependencies = Object.keys(after.dependencies ?? {})
  const plugins = [...(after.dsh?.profile?.bundles ?? [])]
  let changed = false
  for (const packageName of dependencies) {
    const isBundle = exportsPatch(packageName, dir)
    if (isBundle && !plugins.includes(packageName)) {
      plugins.push(packageName)
      changed = true
    }
  }
  const dependencySet = new Set(dependencies)
  for (const packageName of [...plugins]) {
    const wasDependency = beforeDeps.has(packageName) || dependencySet.has(packageName)
    const stillBundle = dependencySet.has(packageName) && exportsPatch(packageName, dir)
    if (wasDependency && !stillBundle) {
      plugins.splice(plugins.indexOf(packageName), 1)
      changed = true
    }
  }
  if (changed) {
    after.dsh = { ...after.dsh, profile: { ...after.dsh?.profile, bundles: plugins } }
    writeProfileManifest(dir, after)
  }
  return after
}

/** Installed dependency rows with versions and bundle-layer membership. */
export function installedEntries(manifest: ProfileManifest, dir: string): MarketplaceInstalledEntry[] {
  const bundles = new Set(manifest.dsh?.profile?.bundles ?? [])
  const entries: MarketplaceInstalledEntry[] = []
  for (const packageName of Object.keys(manifest.dependencies ?? {})) {
    const version = installedVersion(packageName, dir)
    if (version === null) continue
    const declared = manifest.dependencies?.[packageName]
    entries.push({
      packageName,
      version,
      isBundle: bundles.has(packageName),
      currentSpec: typeof declared === 'string' ? declared : '',
      registryRepo: null,
      availableVersion: null,
      verifiedCommit: null,
      updateAvailable: false,
      canUpdate: false,
      install: null,
    })
  }
  return entries.sort((a, b) => a.packageName.localeCompare(b.packageName))
}
