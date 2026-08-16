/** Progress and continuation policy for one-click, multi-run full verification. */

import { planCompatibilityScan } from './compatibility-core.mjs'
import { planSecurityScan } from './security-core.mjs'

export const FULL_SCAN_STATE_SCHEMA_VERSION = 1
export const FULL_SCAN_DEFAULT_RATE_MINIMUM = 750
export const FULL_SCAN_DEFAULT_MAX_WAVES = 50
export const FULL_SCAN_STALL_LIMIT = 3

const FULL_SCAN_STATUSES = new Set(['active', 'paused', 'completed'])

export function fullScanCounts(registry, securityReport, compatibilityReport, registryState = undefined) {
  const security = planSecurityScan(registry, securityReport, 1, 1, registryState)
  const compatibility = planCompatibilityScan(registry, securityReport, compatibilityReport, 1, 1)
  const securityPending = security.selected.length + security.remaining
  const compatibilityPending = compatibility.selected.length + compatibility.remaining
  const securityCurrent = registry.plugins.length - securityPending
  const compatibilityCurrent = compatibility.eligible - compatibilityPending

  return {
    plugins: registry.plugins.length,
    security: {
      current: securityCurrent,
      pending: securityPending,
    },
    compatibility: {
      eligible: compatibility.eligible,
      current: compatibilityCurrent,
      pending: compatibilityPending,
    },
    completedEvidence: securityCurrent + compatibilityCurrent,
    remainingWork: securityPending + compatibilityPending,
  }
}

export function advanceFullScan({
  counts,
  previous = undefined,
  sessionId,
  wave,
  runId = '',
  rateRemaining = null,
  rateMinimum = FULL_SCAN_DEFAULT_RATE_MINIMUM,
  rateResetAt = null,
  maxWaves = FULL_SCAN_DEFAULT_MAX_WAVES,
  now = new Date().toISOString(),
}) {
  if (!validCounts(counts)) throw new Error('full scan counts are invalid')
  if (typeof sessionId !== 'string' || sessionId === '') throw new Error('full scan session id is required')
  if (!Number.isInteger(wave) || wave < 0) throw new Error('full scan wave must be a non-negative integer')
  if (!Number.isInteger(rateMinimum) || rateMinimum < 0) throw new Error('full scan rate minimum must be a non-negative integer')
  if (!Number.isInteger(maxWaves) || maxWaves < 1) throw new Error('full scan max waves must be a positive integer')
  if (rateRemaining !== null && (!Number.isInteger(rateRemaining) || rateRemaining < 0)) throw new Error('rate remaining must be null or a non-negative integer')
  if (Number.isNaN(Date.parse(now))) throw new Error('full scan timestamp is invalid')

  const sameSession = validFullScanState(previous) && previous.sessionId === sessionId
  const stalledWaves = sameSession && counts.completedEvidence <= previous.progress.completedEvidence
    ? previous.progress.stalledWaves + 1
    : 0
  const nextWave = wave + 1
  let status = 'active'
  let pauseReason = null

  if (counts.remainingWork === 0) {
    status = 'completed'
  } else if (rateRemaining !== null && rateRemaining < rateMinimum) {
    status = 'paused'
    pauseReason = 'github-api-rate-limit'
  } else if (nextWave >= maxWaves) {
    status = 'paused'
    pauseReason = 'maximum-wave-limit'
  } else if (stalledWaves >= FULL_SCAN_STALL_LIMIT) {
    status = 'paused'
    pauseReason = 'no-progress'
  }

  const state = {
    schemaVersion: FULL_SCAN_STATE_SCHEMA_VERSION,
    sessionId,
    status,
    wave,
    startedAt: sameSession ? previous.startedAt : now,
    updatedAt: now,
    lastRunId: String(runId),
    pauseReason,
    rateLimit: {
      remaining: rateRemaining,
      minimum: rateMinimum,
      resetAt: rateResetAt,
    },
    plugins: counts.plugins,
    security: counts.security,
    compatibility: counts.compatibility,
    progress: {
      completedEvidence: counts.completedEvidence,
      remainingWork: counts.remainingWork,
      stalledWaves,
    },
  }

  return {
    state,
    nextWave,
    shouldContinue: status === 'active',
  }
}

export function validFullScanState(value) {
  return plainObject(value)
    && value.schemaVersion === FULL_SCAN_STATE_SCHEMA_VERSION
    && typeof value.sessionId === 'string'
    && FULL_SCAN_STATUSES.has(value.status)
    && Number.isInteger(value.wave) && value.wave >= 0
    && !Number.isNaN(Date.parse(value.startedAt))
    && !Number.isNaN(Date.parse(value.updatedAt))
    && typeof value.lastRunId === 'string'
    && (value.pauseReason === null || typeof value.pauseReason === 'string')
    && plainObject(value.rateLimit)
    && (value.rateLimit.remaining === null || (Number.isInteger(value.rateLimit.remaining) && value.rateLimit.remaining >= 0))
    && Number.isInteger(value.rateLimit.minimum) && value.rateLimit.minimum >= 0
    && (value.rateLimit.resetAt === null || !Number.isNaN(Date.parse(value.rateLimit.resetAt)))
    && Number.isInteger(value.plugins) && value.plugins >= 0
    && validPair(value.security, ['current', 'pending'])
    && validPair(value.compatibility, ['eligible', 'current', 'pending'])
    && validPair(value.progress, ['completedEvidence', 'remainingWork', 'stalledWaves'])
}

function validCounts(value) {
  return plainObject(value)
    && Number.isInteger(value.plugins) && value.plugins >= 0
    && validPair(value.security, ['current', 'pending'])
    && validPair(value.compatibility, ['eligible', 'current', 'pending'])
    && Number.isInteger(value.completedEvidence) && value.completedEvidence >= 0
    && Number.isInteger(value.remainingWork) && value.remainingWork >= 0
}

function validPair(value, keys) {
  return plainObject(value) && keys.every(key => Number.isInteger(value[key]) && value[key] >= 0)
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
