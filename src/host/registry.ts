/** Central verified-plugin Registry reader and local search index. */

import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type {
  MarketplaceRegistry,
  MarketplaceRegistryPlugin,
  MarketplaceSearchPage,
} from '../types.ts'

const PAGE_SIZE = 30

function safePackagePath(value: string): boolean {
  return value === '' || (value.length <= 512
    && !value.startsWith('/')
    && !value.includes('\\')
    && !value.includes('\0')
    && value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..'))
}

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

const registryV3Schema = z.object({
  schemaVersion: z.literal(3),
  generatedAt: z.iso.datetime(),
  plugins: z.array(registryPluginBaseSchema.extend({
    id: z.string().min(1),
    packagePath: z.string().refine(safePackagePath),
    install: installSchema,
  }).strict()),
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
        plugin.packagePath,
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
      return primary !== 0 ? primary : left.id.localeCompare(right.id)
    })
    const offset = (page - 1) * PAGE_SIZE
    return {
      totalCount: filtered.length,
      items: filtered.slice(offset, offset + PAGE_SIZE),
      rate: { limit: 0, remaining: 0, reset: 0, source: 'search' },
    }
  }

  /** Find one currently verified repository, case-insensitively. */
  async find(repo: string, packagePath = ''): Promise<MarketplaceRegistryPlugin | undefined> {
    const normalized = registryId(repo.trim(), packagePath).toLocaleLowerCase()
    return (await this.load()).plugins.find(plugin => plugin.id.toLocaleLowerCase() === normalized)
  }

  /** Find the Registry owner of one installed npm package name. */
  async findByPackage(packageName: string, currentSpec = ''): Promise<MarketplaceRegistryPlugin | undefined> {
    const matches = (await this.load()).plugins.filter(plugin => plugin.packageName === packageName)
    if (matches.length <= 1) return matches[0]
    const source = githubIdentity(currentSpec)
    if (source !== null) {
      return matches.find(plugin => plugin.fullName.toLocaleLowerCase() === source.repo
        && plugin.packagePath.toLocaleLowerCase() === source.packagePath) ?? matches[0]
    }
    return matches[0]
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
    const registry = normalizeRegistry(raw)
    const names = new Set<string>()
    for (const plugin of registry.plugins) {
      const expectedId = registryId(plugin.fullName, plugin.packagePath)
      if (plugin.id !== expectedId) throw new Error(`Registry plugin id does not match repository and packagePath: ${JSON.stringify(plugin.id)}`)
      const key = plugin.id.toLocaleLowerCase()
      if (names.has(key)) throw new Error(`Registry repeats plugin identity ${JSON.stringify(plugin.id)}`)
      names.add(key)
      if (plugin.install.mode === 'automatic') {
        const expected = githubSpec(plugin.fullName, plugin.verifiedCommit, plugin.packagePath)
        if (plugin.install.source !== 'github' || plugin.install.spec.toLocaleLowerCase() !== expected.toLocaleLowerCase()) {
          throw new Error(`Registry automatic install is not pinned to ${JSON.stringify(expected)}`)
        }
      }
    }
    this.cache = { registry, etag, expiresAt: Date.now() + this.cacheMs, source }
    return registry
  }
}

/** Continue accepting v1/v2 registries while remote mirrors migrate to packagePath identities. */
function normalizeRegistry(raw: unknown): MarketplaceRegistry {
  const version = typeof raw === 'object' && raw !== null && 'schemaVersion' in raw
    ? (raw as { schemaVersion?: unknown }).schemaVersion
    : undefined
  if (version === 3) return registryV3Schema.parse(raw) as MarketplaceRegistry
  if (version === 2) {
    const legacy = registryV2Schema.parse(raw)
    return {
      schemaVersion: 3,
      generatedAt: legacy.generatedAt,
      plugins: legacy.plugins.map(plugin => withRootIdentity(plugin)),
    }
  }
  const legacy = registryV1Schema.parse(raw)
  return {
    schemaVersion: 3,
    generatedAt: legacy.generatedAt,
    plugins: legacy.plugins.map(plugin => ({
      ...withRootIdentity(plugin),
      install: legacyInstall(plugin),
    })),
  }
}

function withRootIdentity<T extends { fullName: string }>(plugin: T): T & { id: string; packagePath: string } {
  return { ...plugin, id: plugin.fullName, packagePath: '' }
}

function registryId(repo: string, packagePath: string): string {
  return packagePath === '' ? repo : repo + '&path:/' + packagePath
}

function githubSpec(repo: string, commit: string, packagePath: string): string {
  return 'github:' + repo + '#' + commit + (packagePath === '' ? '' : '&path:/' + packagePath)
}

function githubIdentity(spec: string): { repo: string; packagePath: string } | null {
  const match = /^github:([^/#&]+\/[^/#&]+)(?:#[^&]+)?(?:&path:\/([^&]+))?$/i.exec(spec.trim())
  if (match === null) return null
  return { repo: match[1]!.toLocaleLowerCase(), packagePath: (match[2] ?? '').toLocaleLowerCase() }
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
