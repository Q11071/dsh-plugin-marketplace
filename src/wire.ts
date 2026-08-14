/** Hand-written Typert wire artifacts for the `marketplace` Remote service.
 *  Mirrors the generator output shape (see dsh-host-plugin-inventory's
 *  lib/typert.host.js / lib/typert.remote-client.js): the host loader
 *  validates this manifest and the client remote mounts the contribution.
 *  Every parameter and result uses a strict zod-v4 codec; the schemas
 *  therefore carry the wire contract, not just the TypeScript types.
 */

import { z } from 'zod'

const rateSchema = z.object({
  limit: z.number(),
  remaining: z.number(),
  reset: z.number(),
  source: z.union([z.literal('core'), z.literal('search')]),
})

const installMetadataSchema = z.object({
  mode: z.union([z.literal('automatic'), z.literal('guided')]),
  source: z.union([z.literal('github'), z.literal('npm'), z.literal('tarball'), z.literal('manual')]),
  spec: z.string(),
  profiles: z.array(z.string()),
  requiresBuildApproval: z.boolean(),
  requiresRestart: z.boolean(),
  manualSteps: z.boolean(),
  instructionsUrl: z.string(),
})

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

const repoSummarySchema = z.object({
  owner: z.string(),
  repo: z.string(),
  fullName: z.string(),
  description: z.union([z.string(), z.null()]),
  stars: z.number(),
  forks: z.number(),
  openIssues: z.number(),
  language: z.union([z.string(), z.null()]),
  license: z.union([z.string(), z.null()]),
  updatedAt: z.string(),
  defaultBranch: z.string(),
  verifiedCommit: z.string(),
  htmlUrl: z.string(),
  topics: z.array(z.string()),
  categories: z.array(categorySchema),
  starGrowth7d: z.number(),
  packageName: z.string(),
  version: z.string(),
  bundlePatch: z.string(),
  hasClient: z.boolean(),
  verifiedAt: z.string(),
  install: installMetadataSchema,
})

const manifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string(),
  license: z.union([z.string(), z.null()]),
  bundlePatch: z.union([z.string(), z.null()]),
  hasClient: z.boolean(),
})

const detailsValueSchema = z.object({
  repo: z.string(),
  ref: z.string(),
  resolvedRef: z.string(),
  manifest: z.union([manifestSchema, z.null()]),
  patch: z.union([z.string(), z.null()]),
  readmeUrl: z.string(),
  rate: rateSchema,
})

const searchValueSchema = z.object({
  totalCount: z.number(),
  items: z.array(repoSummarySchema),
  rate: rateSchema,
})

const jobIdValueSchema = z.object({ jobId: z.string() })

const jobStatusValueSchema = z.object({
  jobId: z.string(),
  kind: z.string(),
  packageName: z.string(),
  phase: z.string(),
  log: z.string(),
  exitCode: z.union([z.number(), z.null()]),
  startedAt: z.number(),
  finishedAt: z.union([z.number(), z.null()]),
  outcome: z.union([z.object({
    packageName: z.string(),
    version: z.string(),
    requiresRestart: z.boolean(),
  }), z.null()]),
  failure: z.union([z.object({
    code: z.string(),
    message: z.string(),
  }), z.null()]),
})

const installedValueSchema = z.object({
  profile: z.string(),
  entries: z.array(z.object({
    packageName: z.string(),
    version: z.string(),
    isBundle: z.boolean(),
    enabled: z.boolean(),
    currentSpec: z.string(),
    registryRepo: z.union([z.string(), z.null()]),
    availableVersion: z.union([z.string(), z.null()]),
    verifiedCommit: z.union([z.string(), z.null()]),
    updateAvailable: z.boolean(),
    canUpdate: z.boolean(),
    install: z.union([installMetadataSchema, z.null()]),
  })),
})

const searchRequestSchema = z.object({
  query: z.string(),
  page: z.number(),
  sort: z.union([z.literal('stars'), z.literal('updated'), z.literal('trending')]),
  category: z.union([z.literal('all'), categorySchema]),
})

const detailsRequestSchema = z.object({
  repo: z.string(),
  ref: z.string(),
})

const installRequestSchema = z.object({
  repo: z.string(),
  ref: z.string(),
})

const jobStatusRequestSchema = z.object({
  jobId: z.string(),
})

const uninstallRequestSchema = z.object({
  packageName: z.string(),
})

const toggleRequestSchema = z.object({
  packageName: z.string(),
  enabled: z.boolean(),
})

const toggleValueSchema = z.object({
  packageName: z.string(),
  enabled: z.boolean(),
  requiresRestart: z.boolean(),
})

const restartValueSchema = z.object({
  accepted: z.literal(true),
  profile: z.string(),
})

/** Business failure: typed code + message + optional payload. */
const failureSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown(),
})

/** The RemoteResult envelope the client API resolves to. */
function resultSchema<T extends z.ZodTypeAny>(value: T) {
  return z.union([
    z.object({ ok: z.literal(true), value }),
    z.object({ ok: z.literal(false), error: failureSchema }),
  ])
}

type Codec = { mode: 'strict'; typeSymbol: string; schema: z.ZodTypeAny }

function param(name: string, schema: z.ZodTypeAny, typeSymbol: string) {
  return {
    name,
    wire: name,
    source: 'json' as const,
    codec: { mode: 'strict' as const, typeSymbol, schema } satisfies Codec,
  }
}

function result(schema: z.ZodTypeAny, typeSymbol: string) {
  return { mode: 'strict' as const, typeSymbol, schema } satisfies Codec
}

const PKG = 'dsh-plugin-marketplace'
const NS = 'marketplace'

function invocation(method: string, parameters: ReturnType<typeof param>[], codec: ReturnType<typeof result>) {
  return {
    id: `${PKG}#${NS}/${method}`,
    service: NS,
    namespace: NS,
    method,
    invocation: { kind: 'direct' as const },
    parameters,
    result: codec,
  }
}

const REQUEST_TYPES = `${PKG}/types#`

/** Host-face manifest registered by @deepseek-ai/dsh-typert-loader. */
export const TYPERT = {
  package: PKG,
  face: 'host',
  schemas: [],
  invocations: [
    invocation('search', [param('request', searchRequestSchema, `${REQUEST_TYPES}MarketplaceSearchRequest`)], result(resultSchema(searchValueSchema), `${REQUEST_TYPES}MarketplaceSearchOutcome`)),
    invocation('details', [param('request', detailsRequestSchema, `${REQUEST_TYPES}MarketplaceDetailsRequest`)], result(resultSchema(detailsValueSchema), `${REQUEST_TYPES}MarketplaceDetailsOutcome`)),
    invocation('installPlugin', [param('request', installRequestSchema, `${REQUEST_TYPES}MarketplaceInstallRequest`)], result(resultSchema(jobIdValueSchema), `${REQUEST_TYPES}MarketplaceInstallOutcome`)),
    invocation('update', [param('request', installRequestSchema, `${REQUEST_TYPES}MarketplaceInstallRequest`)], result(resultSchema(jobIdValueSchema), `${REQUEST_TYPES}MarketplaceInstallOutcome`)),
    invocation('uninstall', [param('request', uninstallRequestSchema, `${REQUEST_TYPES}MarketplaceUninstallRequest`)], result(resultSchema(jobIdValueSchema), `${REQUEST_TYPES}MarketplaceInstallOutcome`)),
    invocation('setEnabled', [param('request', toggleRequestSchema, `${REQUEST_TYPES}MarketplaceToggleRequest`)], result(resultSchema(toggleValueSchema), `${REQUEST_TYPES}MarketplaceToggleOutcome`)),
    invocation('jobStatus', [param('request', jobStatusRequestSchema, `${REQUEST_TYPES}MarketplaceJobStatusRequest`)], result(resultSchema(jobStatusValueSchema), `${REQUEST_TYPES}MarketplaceJobStatusOutcome`)),
    invocation('installed', [], result(resultSchema(installedValueSchema), `${REQUEST_TYPES}MarketplaceInstalledOutcome`)),
    invocation('restart', [], result(resultSchema(restartValueSchema), `${REQUEST_TYPES}MarketplaceRestartOutcome`)),
  ],
  model: {
    services: [],
    events: [],
    objects: [],
  },
}

/** Client-side contribution mounted through ctx.remote.$mount(). */
export const TYPERT_REMOTE = {
  package: PKG,
  descriptors: TYPERT.invocations,
}

export default TYPERT_REMOTE
