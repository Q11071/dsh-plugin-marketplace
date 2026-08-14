/** Central verified-plugin Registry reader and local search index. */

import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type {
  MarketplaceRegistry,
  MarketplaceRegistryPlugin,
  MarketplacePluginCategory,
  MarketplaceSearchPage,
} from '../types.ts'

const PAGE_SIZE = 30

const categorySchema = z.union([
  z.literal('ui'),
  z.literal('agents'),
  z.literal('developer-tools'),
  z.literal('models'),
  z.literal('data'),
  z.literal('integrations'),
  z.literal('media'),
  z.literal('security'),
  z.literal('observability'),
  z.literal('other'),
])

const discoverySchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.iso.datetime(),
  windowDays: z.literal(7),
  plugins: z.array(z.object({
    fullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    categories: z.array(categorySchema).min(1).max(3),
    starGrowth7d: z.number().int().nonnegative(),
  }).strict()),
}).strict()

const installSchema = z.object({
  mode: z.union([z.literal('automatic'), z.literal('guided')]),
  source: z.union([z.literal('github'), z.literal('npm'), z.literal('tarball'), z.literal('manual')]),
  spec: z.string(),
  profiles: z.array(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)),
  requiresBuildApproval: z.boolean(),
  requiresRestart: z.boolean(),
  manualSteps: z.boolean(),
  instructionsUrl: z.url(),
}).strict()

const registryPluginBaseSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  fullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  description: z.string().nullable(),
  stars: z.number().int().nonnegative(),
  forks: z.number().int().nonnegative(),
  openIssues: z.number().int().nonnegative(),
  language: z.string().nullable(),
  license: z.string().nullable(),
  updatedAt: z.iso.datetime(),
  defaultBranch: z.string().min(1),
  verifiedCommit: z.string().regex(/^[0-9a-f]{40}$/i),
  htmlUrl: z.url(),
  topics: z.array(z.string()),
  packageName: z.string().min(1),
  version: z.string().min(1),
  bundlePatch: z.string().min(1),
  hasClient: z.boolean(),
  verifiedAt: z.iso.datetime(),
})

const registryV1Schema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.iso.datetime(),
  plugins: z.array(registryPluginBaseSchema.strict()),
}).strict()

const registryV2Schema = z.object({
  schemaVersion: z.literal(2),
  generatedAt: z.iso.datetime(),
  plugins: z.array(registryPluginBaseSchema.extend({ install: installSchema }).strict()),
}).strict()

/** Loader schema for Registry access policy. */
export const RegistryConfigSchema = z.object({
  registryUrl: z.url().optional(),
  registryCacheMinutes: z.number().int().min(1).max(1440).default(15),
  registryRequestTimeoutMs: z.number().int().min(1000).max(60000).default(10000),
}).default({
  registryCacheMinutes: 15,
  registryRequestTimeoutMs: 10000,
})

/** Validated configuration for fetching the central Registry. */
export type RegistryConfig = z.output<typeof RegistryConfigSchema>

interface RegistryCache {
  registry: MarketplaceRegistry
  etag: string | null
  expiresAt: number
  source: string
}

/** Registry read or validation failure surfaced as a marketplace business error. */
export class RegistryError extends Error {
  readonly code = 'registry-unavailable'
  readonly details: Record<string, unknown>

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'RegistryError'
    this.details = details
  }
}

/** Read, cache, validate, and search one central Registry document. */
export class RegistryClient {
  private cache: RegistryCache | undefined
  private readonly source: string
  private readonly bundledSource: string
  private readonly cacheMs: number
  private readonly timeoutMs: number

  constructor(
    source: string,
    bundledSource: string,
    cacheMs: number,
    timeoutMs: number,
  ) {
    this.source = source
    this.bundledSource = bundledSource
    this.cacheMs = cacheMs
    this.timeoutMs = timeoutMs
  }

  /** Search only centrally verified entries. */
  async search(
    query: string,
    page: number,
    sort: 'stars' | 'updated' | 'trending',
    category: MarketplacePluginCategory | 'all',
  ): Promise<MarketplaceSearchPage> {
    const registry = await this.load()
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
    const filtered = registry.plugins.filter((plugin) => {
      if (category !== 'all' && !plugin.categories.includes(category)) return false
      if (terms.length === 0) return true
      const text = [
        plugin.fullName,
        plugin.packageName,
        plugin.description ?? '',
        plugin.language ?? '',
        ...plugin.topics,
        ...plugin.categories,
      ].join('\n').toLocaleLowerCase()
      return terms.every(term => text.includes(term))
    })
    filtered.sort((left, right) => {
      const primary = sort === 'updated'
        ? Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
        : sort === 'trending'
          ? right.starGrowth7d - left.starGrowth7d
          : right.stars - left.stars
      if (primary !== 0) return primary
      const secondary = sort === 'trending' ? right.stars - left.stars : 0
      return secondary !== 0 ? secondary : left.fullName.localeCompare(right.fullName)
    })
    const offset = (page - 1) * PAGE_SIZE
    return {
      totalCount: filtered.length,
      items: filtered.slice(offset, offset + PAGE_SIZE),
      rate: { limit: 0, remaining: 0, reset: 0, source: 'search' },
    }
  }

  /** Find one currently verified repository, case-insensitively. */
  async find(repo: string): Promise<MarketplaceRegistryPlugin | undefined> {
    const normalized = repo.trim().toLocaleLowerCase()
    return (await this.load()).plugins.find(plugin => plugin.fullName.toLocaleLowerCase() === normalized)
  }

  /** Find the Registry owner of one installed npm package name. */
  async findByPackage(packageName: string): Promise<MarketplaceRegistryPlugin | undefined> {
    return (await this.load()).plugins.find(plugin => plugin.packageName === packageName)
  }

  private async load(): Promise<MarketplaceRegistry> {
    if (this.cache !== undefined && Date.now() < this.cache.expiresAt) return this.cache.registry
    try {
      return await this.loadSource(this.source)
    } catch (error) {
      if (this.cache !== undefined) {
        this.cache.expiresAt = Date.now() + Math.min(this.cacheMs, 60_000)
        return this.cache.registry
      }
      if (this.source !== this.bundledSource) {
        try {
          return await this.loadSource(this.bundledSource)
        } catch (fallbackError) {
          throw unavailable(this.source, error, fallbackError)
        }
      }
      throw unavailable(this.source, error)
    }
  }

  private async loadSource(source: string): Promise<MarketplaceRegistry> {
    const url = new URL(source)
    let raw: unknown
    let etag: string | null = null
    if (url.protocol === 'file:') {
      raw = JSON.parse(await readFile(url, 'utf8')) as unknown
    } else if (url.protocol === 'https:' || url.protocol === 'http:') {
      const headers: Record<string, string> = { accept: 'application/json' }
      if (this.cache?.source === source && this.cache.etag !== null) headers['if-none-match'] = this.cache.etag
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(this.timeoutMs) })
      if (response.status === 304 && this.cache?.source === source) {
        this.cache.expiresAt = Date.now() + this.cacheMs
        return this.cache.registry
      }
      if (!response.ok) throw new Error(`Registry returned HTTP ${String(response.status)}`)
      raw = await response.json() as unknown
      etag = response.headers.get('etag')
    } else {
      throw new Error(`Unsupported Registry URL protocol ${JSON.stringify(url.protocol)}`)
    }
    const registry = applyDiscovery(normalizeRegistry(raw), await this.loadDiscovery(source))
    const names = new Set<string>()
    for (const plugin of registry.plugins) {
      const key = plugin.fullName.toLocaleLowerCase()
      if (names.has(key)) throw new Error(`Registry repeats repository ${JSON.stringify(plugin.fullName)}`)
      names.add(key)
      if (plugin.install.mode === 'automatic') {
        const github = 'github:' + plugin.fullName + '#' + plugin.verifiedCommit
        const npm = plugin.packageName + '@' + plugin.version
        const exact = (plugin.install.source === 'github'
          && plugin.install.spec.toLocaleLowerCase() === github.toLocaleLowerCase())
          || (plugin.install.source === 'npm' && plugin.install.spec === npm)
        if (!exact) {
          throw new Error(`Registry automatic install is not pinned to an exact verified source for ${JSON.stringify(plugin.fullName)}`)
        }
      }
    }
    this.cache = { registry, etag, expiresAt: Date.now() + this.cacheMs, source }
    return registry
  }

  /** Discovery metadata is optional so custom and legacy registries still load. */
  private async loadDiscovery(source: string): Promise<z.output<typeof discoverySchema> | undefined> {
    try {
      const url = discoverySource(source)
      let raw: unknown
      if (url.protocol === 'file:') {
        raw = JSON.parse(await readFile(url, 'utf8')) as unknown
      } else if (url.protocol === 'https:' || url.protocol === 'http:') {
        const response = await fetch(url, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(this.timeoutMs),
        })
        if (!response.ok) return undefined
        raw = await response.json() as unknown
      } else {
        return undefined
      }
      return discoverySchema.parse(raw)
    } catch {
      return undefined
    }
  }
}

/** Continue accepting v1 registries while remote mirrors migrate to install metadata. */
function normalizeRegistry(raw: unknown): MarketplaceRegistry {
  const version = typeof raw === 'object' && raw !== null && 'schemaVersion' in raw
    ? (raw as { schemaVersion?: unknown }).schemaVersion
    : undefined
  if (version === 2) {
    const current = registryV2Schema.parse(raw)
    return {
      ...current,
      plugins: current.plugins.map(plugin => withDefaultDiscovery(plugin)),
    }
  }
  const legacy = registryV1Schema.parse(raw)
  return {
    schemaVersion: 2,
    generatedAt: legacy.generatedAt,
    plugins: legacy.plugins.map(plugin => withDefaultDiscovery({
      ...plugin,
      install: legacyInstall(plugin),
    })),
  }
}

function withDefaultDiscovery<T extends z.output<typeof registryPluginBaseSchema> & { install: MarketplaceRegistryPlugin['install'] }>(
  plugin: T,
): MarketplaceRegistryPlugin {
  return { ...plugin, categories: ['other'], starGrowth7d: 0 }
}

function applyDiscovery(
  registry: MarketplaceRegistry,
  discovery: z.output<typeof discoverySchema> | undefined,
): MarketplaceRegistry {
  if (discovery === undefined) return registry
  const rows = new Map(discovery.plugins.map(row => [row.fullName.toLocaleLowerCase(), row]))
  return {
    ...registry,
    plugins: registry.plugins.map(plugin => {
      const row = rows.get(plugin.fullName.toLocaleLowerCase())
      if (row === undefined) return plugin
      return { ...plugin, categories: [...new Set(row.categories)], starGrowth7d: row.starGrowth7d }
    }),
  }
}

function discoverySource(source: string): URL {
  const url = new URL(source)
  const slash = url.pathname.lastIndexOf('/')
  url.pathname = url.pathname.slice(0, slash + 1) + 'discovery.json'
  return url
}

function legacyInstall(plugin: z.output<typeof registryPluginBaseSchema>): MarketplaceRegistryPlugin['install'] {
  const profiles = plugin.hasClient ? ['web'] : []
  return {
    mode: profiles.length > 0 ? 'automatic' : 'guided',
    source: 'github',
    spec: 'github:' + plugin.fullName + '#' + plugin.verifiedCommit,
    profiles,
    requiresBuildApproval: false,
    requiresRestart: true,
    manualSteps: profiles.length === 0,
    instructionsUrl: plugin.htmlUrl + '#readme',
  }
}

function unavailable(source: string, error: unknown, fallbackError?: unknown): RegistryError {
  return new RegistryError('The verified plugin Registry could not be loaded.', {
    source,
    cause: error instanceof Error ? error.message : String(error),
    ...fallbackError === undefined ? {} : {
      fallbackCause: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
    },
  })
}
