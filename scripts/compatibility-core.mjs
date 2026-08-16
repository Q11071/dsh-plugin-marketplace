/** Shared policy for exact-commit DSH runtime compatibility verification. */

export const COMPATIBILITY_POLICY_VERSION = 1
export const COMPATIBILITY_HARNESS_VERSION = 7
export const COMPATIBILITY_CHECKS = Object.freeze([
  'install',
  'hostLoad',
  'agentLoop',
  'clientLoad',
  'dispose',
  'update',
  'networkIsolation',
])

const RESULT_STATUSES = new Set(['passed', 'partial', 'failed', 'timeout', 'unsupported', 'error'])
const CHECK_STATUSES = new Set(['passed', 'failed', 'timeout', 'unsupported', 'inconclusive', 'skipped'])

/** Select only automatic installs whose current exact commit passed static security review. */
export function planCompatibilityScan(registry, securityReport, report, limit = 20, batchSize = 2) {
  if (!plainObject(registry) || !Array.isArray(registry.plugins)) throw new Error('Registry root is invalid')
  if (!plainObject(securityReport) || !Array.isArray(securityReport.results)) throw new Error('security report root is invalid')
  if (!validCompatibilityReportRoot(report)) throw new Error('compatibility report root is invalid')
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('compatibility scan limit must be between 1 and 100')
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5) throw new Error('compatibility batch size must be between 1 and 5')

  const security = new Map(securityReport.results.map(row => [row.repository?.toLocaleLowerCase(), row]))
  const previous = new Map(report.results.map(row => [row.repository.toLocaleLowerCase(), row]))
  const queued = []
  let eligible = 0
  for (const plugin of registry.plugins) {
    if (!validPlugin(plugin) || plugin.install.mode !== 'automatic') continue
    const securityRow = security.get(plugin.fullName.toLocaleLowerCase())
    if (securityRow?.verifiedCommit !== plugin.verifiedCommit || securityRow.status !== 'passed') continue
    eligible += 1
    const old = previous.get(plugin.fullName.toLocaleLowerCase())
    let priority
    if (old === undefined) priority = 2
    else if (old.verifiedCommit !== plugin.verifiedCommit || old.harnessVersion !== COMPATIBILITY_HARNESS_VERSION) priority = 0
    else if (old.result === 'error' || old.result === 'timeout') priority = 1
    else continue
    queued.push({
      repository: plugin.fullName,
      verifiedCommit: plugin.verifiedCommit,
      packageName: plugin.packageName,
      version: plugin.version,
      profile: preferredProfile(plugin),
      install: {
        source: plugin.install.source,
        spec: plugin.install.spec,
      },
      hasClient: plugin.hasClient,
      priority,
    })
  }
  queued.sort((left, right) => left.priority - right.priority || left.repository.localeCompare(right.repository))
  const selected = queued.slice(0, limit).map(({ priority: _priority, ...target }) => target)
  const batches = []
  for (let index = 0; index < selected.length; index += batchSize) {
    batches.push({ id: Math.floor(index / batchSize), repositories: selected.slice(index, index + batchSize) })
  }
  return {
    selected,
    batches,
    eligible,
    remaining: Math.max(0, queued.length - selected.length),
  }
}

/** Derive the honest overall result from the market-owned check outcomes. */
export function compatibilityResult(checks, infrastructureError = false) {
  if (infrastructureError) return 'error'
  const values = COMPATIBILITY_CHECKS.map(name => checks?.[name]?.status).filter(Boolean)
  if (values.includes('timeout')) return 'timeout'
  if (values.includes('failed')) return 'failed'
  const executed = values.filter(status => status !== 'skipped')
  if (executed.length === 0 || executed.every(status => status === 'unsupported')) return 'unsupported'
  if (executed.every(status => status === 'passed')) return 'passed'
  return 'partial'
}

export function validCompatibilityReportRoot(value) {
  return plainObject(value)
    && value.schemaVersion === 1
    && value.policyVersion === COMPATIBILITY_POLICY_VERSION
    && !Number.isNaN(Date.parse(value.generatedAt))
    && Array.isArray(value.results)
}

export function validCompatibilityResult(value) {
  return plainObject(value)
    && typeof value.repository === 'string'
    && /^[\w.-]+\/[\w.-]+$/.test(value.repository)
    && /^[0-9a-f]{40}$/i.test(value.verifiedCommit ?? '')
    && typeof value.packageName === 'string'
    && typeof value.version === 'string'
    && typeof value.profile === 'string'
    && Number.isInteger(value.harnessVersion)
    && value.harnessVersion >= 1
    && !Number.isNaN(Date.parse(value.checkedAt))
    && RESULT_STATUSES.has(value.result)
    && value.scope === 'compatibility'
    && plainObject(value.checks)
    && COMPATIBILITY_CHECKS.every(name => validCheck(value.checks[name]))
    && typeof value.log === 'string'
    && value.log.length <= 4000
}

export function emptyChecks(reason = 'not-run') {
  return Object.fromEntries(COMPATIBILITY_CHECKS.map(name => [name, { status: 'skipped', reason }]))
}

function validCheck(value) {
  return plainObject(value)
    && CHECK_STATUSES.has(value.status)
    && typeof value.reason === 'string'
    && value.reason.length <= 500
}

function validPlugin(plugin) {
  if (!plainObject(plugin)
    || typeof plugin.fullName !== 'string'
    || !/^[\w.-]+\/[\w.-]+$/.test(plugin.fullName)
    || !/^[0-9a-f]{40}$/i.test(plugin.verifiedCommit ?? '')
    || typeof plugin.packageName !== 'string'
    || typeof plugin.version !== 'string'
    || typeof plugin.hasClient !== 'boolean'
    || !plainObject(plugin.install)
    || !['github', 'npm'].includes(plugin.install.source)
    || typeof plugin.install.spec !== 'string'
    || !Array.isArray(plugin.install.profiles)) return false
  const github = 'github:' + plugin.fullName + '#' + plugin.verifiedCommit
  const npm = plugin.packageName + '@' + plugin.version
  return (plugin.install.source === 'github' && plugin.install.spec.toLocaleLowerCase() === github.toLocaleLowerCase())
    || (plugin.install.source === 'npm' && plugin.install.spec === npm)
}

function preferredProfile(plugin) {
  if (plugin.install.profiles.includes('web')) return 'web'
  if (plugin.install.profiles.includes('headless')) return 'headless'
  return plugin.hasClient ? 'web' : (plugin.install.profiles[0] ?? 'headless')
}

function plainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
