/** Central verified-plugin Registry reader and local search index. */

import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type {
  MarketplaceRegistry,
  MarketplaceRegistryPlugin,
  MarketplaceSearchPage,
} from '../types.ts'

const PAGE_SIZE = 30

const registryPluginSchema = z.object({
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
}).strict()

const registrySchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.iso.datetime(),
  plugins: z.array(registryPluginSchema),
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

  constructor(message: string, readonly details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'RegistryError'
  }
}

/** Read, cache, validate, and search one central Registry document. */
export class RegistryClient {
  private cache: RegistryCache | undefined

  constructor(
    private readonly source: string,
    private readonly bundledSource: string,
    private readonly cacheMs: number,
    private readonly timeoutMs: number,
  ) {}

  /** Search only centrally verified entries. */
  async search(query: string, page: number, sort: 'stars' | 'updated'): Promise<MarketplaceSearchPage> {
    const registry = await this.load()
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
    const filtered = registry.plugins.filter((plugin) => {
      if (terms.length === 0) return true
      const text = [
        plugin.fullName,
        plugin.packageName,
        plugin.description ?? '',
        plugin.language ?? '',
        ...plugin.topics,
      ].join('\n').toLocaleLowerCase()
      return terms.every(term => text.includes(term))
    })
    filtered.sort((left, right) => {
      const primary = sort === 'updated'
        ? Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
        : right.stars - left.stars
      return primary !== 0 ? primary : left.fullName.localeCompare(right.fullName)
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
    const registry = registrySchema.parse(raw) as MarketplaceRegistry
    const names = new Set<string>()
    for (const plugin of registry.plugins) {
      const key = plugin.fullName.toLocaleLowerCase()
      if (names.has(key)) throw new Error(`Registry repeats repository ${JSON.stringify(plugin.fullName)}`)
      names.add(key)
    }
    this.cache = { registry, etag, expiresAt: Date.now() + this.cacheMs, source }
    return registry
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
