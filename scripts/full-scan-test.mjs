/** Regression tests for resumable one-click full Registry verification. */

import assert from 'node:assert/strict'
import { advanceFullScan, fullScanCounts, validFullScanState } from './full-scan-core.mjs'

const plugins = [
  plugin('owner/done', 'a'),
  plugin('owner/security-pending', 'b'),
  plugin('owner/runtime-pending', 'c'),
]
const registry = { plugins }
const security = {
  schemaVersion: 1,
  policyVersion: 1,
  generatedAt: '2026-08-16T00:00:00Z',
  enforcementStartedAt: '2026-08-01T00:00:00Z',
  results: [
  securityResult('owner/done', 'a', 'passed'),
  securityResult('owner/runtime-pending', 'c', 'passed'),
  ],
}
const compatibility = compatibilityReport([
  compatibilityResult('owner/done', 'a'),
])
const counts = fullScanCounts(registry, security, compatibility)
assert.deepEqual(counts, {
  plugins: 3,
  security: { current: 2, pending: 1 },
  compatibility: { eligible: 2, current: 1, pending: 1 },
  completedEvidence: 3,
  remainingWork: 2,
})

const first = advanceFullScan({
  counts,
  sessionId: 'run-1',
  wave: 0,
  runId: '100',
  rateRemaining: 4000,
  now: '2026-08-16T00:00:00Z',
})
assert.equal(first.shouldContinue, true)
assert.equal(first.nextWave, 1)
assert.equal(first.state.status, 'active')
assert.equal(first.state.progress.stalledWaves, 0)
assert.equal(validFullScanState(first.state), true)

const lowRate = advanceFullScan({
  counts,
  previous: first.state,
  sessionId: 'run-1',
  wave: 1,
  rateRemaining: 749,
  now: '2026-08-16T00:10:00Z',
})
assert.equal(lowRate.shouldContinue, false)
assert.equal(lowRate.state.status, 'paused')
assert.equal(lowRate.state.pauseReason, 'github-api-rate-limit')

let stalled = first.state
for (let wave = 1; wave <= 3; wave += 1) {
  stalled = advanceFullScan({
    counts,
    previous: stalled,
    sessionId: 'run-1',
    wave,
    rateRemaining: 4000,
    now: `2026-08-16T00:${wave}0:00Z`,
  }).state
}
assert.equal(stalled.status, 'paused')
assert.equal(stalled.pauseReason, 'no-progress')

const completeCounts = {
  ...counts,
  security: { current: 3, pending: 0 },
  compatibility: { eligible: 3, current: 3, pending: 0 },
  completedEvidence: 6,
  remainingWork: 0,
}
const complete = advanceFullScan({
  counts: completeCounts,
  previous: first.state,
  sessionId: 'run-1',
  wave: 1,
  rateRemaining: 4000,
  now: '2026-08-16T01:00:00Z',
})
assert.equal(complete.shouldContinue, false)
assert.equal(complete.state.status, 'completed')
assert.equal(complete.state.pauseReason, null)

console.log('Full Registry scan continuation tests passed')

function plugin(fullName, commit) {
  return {
    fullName,
    verifiedCommit: commit.repeat(40),
    verifiedAt: '2026-08-16T00:00:00Z',
    packageName: fullName.split('/')[1],
    version: '1.0.0',
    hasClient: false,
    install: {
      mode: 'automatic',
      source: 'npm',
      spec: fullName.split('/')[1] + '@1.0.0',
      profiles: ['web'],
    },
  }
}

function securityResult(repository, commit, status) {
  return {
    repository,
    verifiedCommit: commit.repeat(40),
    scannerVersion: 2,
    status,
  }
}

function compatibilityReport(results) {
  return {
    schemaVersion: 1,
    policyVersion: 1,
    generatedAt: '2026-08-16T00:00:00Z',
    total: results.length,
    summary: { passed: 0, partial: results.length, failed: 0, timeout: 0, unsupported: 0, error: 0, pending: 0 },
    results,
  }
}

function compatibilityResult(repository, commit) {
  return {
    repository,
    verifiedCommit: commit.repeat(40),
    packageName: repository.split('/')[1],
    version: '1.0.0',
    profile: 'web',
    harnessVersion: 9,
    checkedAt: '2026-08-16T00:00:00Z',
    result: 'partial',
    scope: 'compatibility',
    checks: {},
    log: [],
  }
}
