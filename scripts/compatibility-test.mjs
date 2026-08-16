/** Regression tests for compatibility queueing, status derivation and artifact merging. */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import {
  compatibilityResult,
  emptyChecks,
  planCompatibilityScan,
  validCompatibilityResult,
} from './compatibility-core.mjs'

const registry = {
  plugins: [
    plugin('owner/eligible', 'a', 'automatic'),
    plugin('owner/review', 'b', 'automatic'),
    plugin('owner/guided', 'c', 'guided'),
    plugin('owner/changed', 'd', 'automatic'),
  ],
}
const security = {
  results: [
    securityResult('owner/eligible', 'a', 'passed'),
    securityResult('owner/review', 'b', 'review'),
    securityResult('owner/guided', 'c', 'passed'),
    securityResult('owner/changed', 'd', 'passed'),
  ],
}
const previous = report([result('owner/changed', 'c', 'partial')])
const plan = planCompatibilityScan(registry, security, previous, 10, 2)
assert.equal(plan.eligible, 2)
assert.deepEqual(plan.selected.map(row => row.repository), ['owner/changed', 'owner/eligible'])
assert.equal(plan.batches.length, 1)

const checks = emptyChecks()
checks.install = check('passed', 'installed')
checks.hostLoad = check('passed', 'loaded')
checks.dispose = check('passed', 'disposed')
checks.networkIsolation = check('passed', 'isolated')
checks.agentLoop = check('skipped', 'not-agent')
checks.clientLoad = check('inconclusive', 'browser-not-mounted')
checks.update = check('unsupported', 'no-previous-version')
assert.equal(compatibilityResult(checks), 'partial')
checks.clientLoad = check('passed', 'mounted')
checks.update = check('passed', 'updated')
assert.equal(compatibilityResult(checks), 'passed')
checks.dispose = check('timeout', 'leaked')
assert.equal(compatibilityResult(checks), 'timeout')
assert.equal(validCompatibilityResult(result('owner/eligible', 'a', 'partial')), true)

await mergeIntegrationTest()
console.log('Plugin compatibility policy tests passed')

async function mergeIntegrationTest() {
  const execute = promisify(execFile)
  const scriptRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
  const temporary = await mkdtemp(path.join(tmpdir(), 'dsh-compatibility-merge-test-'))
  try {
    const scans = path.join(temporary, 'scans')
    await mkdir(scans)
    const candidate = plugin('owner/eligible', 'a', 'automatic')
    await json(path.join(temporary, 'registry.json'), { schemaVersion: 2, generatedAt: '2026-08-16T00:00:00Z', plugins: [candidate] })
    await json(path.join(temporary, 'report.json'), report([]))
    await json(path.join(temporary, 'plan.json'), {
      schemaVersion: 1,
      generatedAt: '2026-08-16T00:00:00Z',
      selected: [{ repository: candidate.fullName, verifiedCommit: candidate.verifiedCommit, profile: 'web' }],
      remaining: 0,
    })
    await json(path.join(scans, 'result.json'), {
      schemaVersion: 1,
      policyVersion: 1,
      results: [result(candidate.fullName, 'a', 'partial')],
    })
    await execute(process.execPath, [
      path.join(scriptRoot, 'scripts', 'compatibility-merge.mjs'),
      '--plan', path.join(temporary, 'plan.json'),
      '--results', scans,
      '--registry', path.join(temporary, 'registry.json'),
      '--report', path.join(temporary, 'report.json'),
    ], { windowsHide: true })
    const merged = JSON.parse(await readFile(path.join(temporary, 'report.json'), 'utf8'))
    assert.equal(merged.total, 1)
    assert.equal(merged.summary.partial, 1)
    assert.equal(merged.summary.pending, 0)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

function plugin(fullName, commit, mode) {
  return {
    fullName,
    verifiedCommit: commit.repeat(40),
    packageName: fullName.split('/')[1],
    version: '1.0.0',
    hasClient: true,
    install: {
      mode,
      source: 'npm',
      spec: fullName.split('/')[1] + '@1.0.0',
      profiles: ['web'],
    },
  }
}

function securityResult(repository, commit, status) {
  return { repository, verifiedCommit: commit.repeat(40), status }
}

function report(results) {
  return {
    schemaVersion: 1,
    policyVersion: 1,
    generatedAt: '2026-08-16T00:00:00Z',
    total: results.length,
    summary: { passed: 0, partial: results.length, failed: 0, timeout: 0, unsupported: 0, error: 0, pending: 0 },
    results,
  }
}

function result(repository, commit, status) {
  const checks = emptyChecks('test')
  checks.install = check('passed', 'test')
  return {
    repository,
    verifiedCommit: commit.repeat(40),
    packageName: repository.split('/')[1],
    version: '1.0.0',
    profile: 'web',
    harnessVersion: 2,
    checkedAt: '2026-08-16T00:00:00Z',
    result: status,
    scope: 'compatibility',
    checks,
    log: '',
  }
}

function check(status, reason) {
  return { status, reason }
}

async function json(file, value) {
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
}
