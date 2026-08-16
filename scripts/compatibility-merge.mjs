/** Validate unprivileged compatibility artifacts and merge exact-commit results. */

import { readdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  COMPATIBILITY_CHECKS,
  COMPATIBILITY_HARNESS_VERSION,
  COMPATIBILITY_POLICY_VERSION,
  emptyChecks,
  validCompatibilityReportRoot,
  validCompatibilityResult,
} from './compatibility-core.mjs'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const planPath = path.resolve(root, argument('--plan') ?? '.compatibility-results/plan/plan.json')
const resultsDirectory = path.resolve(root, argument('--results') ?? '.compatibility-results/scans')
const registryPath = path.resolve(root, argument('--registry') ?? 'registry/plugins.json')
const reportPath = path.resolve(root, argument('--report') ?? 'registry/compatibility-report.json')
const plan = JSON.parse(await readFile(planPath, 'utf8'))
const registry = JSON.parse(await readFile(registryPath, 'utf8'))
const previous = JSON.parse(await readFile(reportPath, 'utf8'))

if (!plainObject(plan) || plan.schemaVersion !== 1 || !Array.isArray(plan.selected)) throw new Error('compatibility plan is invalid')
if (!validCompatibilityReportRoot(previous)) throw new Error('previous compatibility report is invalid')
const registryMap = new Map(registry.plugins.map(plugin => [plugin.fullName.toLocaleLowerCase(), plugin]))
const planned = new Map()
for (const target of plan.selected) {
  const plugin = registryMap.get(target.repository?.toLocaleLowerCase())
  if (plugin === undefined || plugin.verifiedCommit !== target.verifiedCommit) {
    throw new Error('compatibility plan no longer matches Registry: ' + String(target.repository))
  }
  planned.set(target.repository.toLocaleLowerCase(), target)
}

const received = new Map()
for (const file of await jsonFiles(resultsDirectory)) {
  const artifact = JSON.parse(await readFile(file, 'utf8'))
  if (!plainObject(artifact) || artifact.schemaVersion !== 1 || artifact.policyVersion !== COMPATIBILITY_POLICY_VERSION || !Array.isArray(artifact.results)) {
    throw new Error('invalid compatibility artifact: ' + file)
  }
  for (const candidate of artifact.results) {
    if (!validCompatibilityResult(candidate)) throw new Error('invalid compatibility result for ' + String(candidate?.repository))
    const key = candidate.repository.toLocaleLowerCase()
    const target = planned.get(key)
    if (target === undefined || target.verifiedCommit !== candidate.verifiedCommit) throw new Error('unplanned compatibility result: ' + candidate.repository)
    if (received.has(key)) throw new Error('duplicate compatibility result: ' + candidate.repository)
    received.set(key, sanitize(candidate))
  }
}

for (const [key, target] of planned) {
  if (received.has(key)) continue
  const plugin = registryMap.get(key)
  const checks = emptyChecks('scan-job-produced-no-result-artifact')
  received.set(key, {
    repository: plugin.fullName,
    verifiedCommit: plugin.verifiedCommit,
    packageName: plugin.packageName,
    version: plugin.version,
    profile: target.profile,
    harnessVersion: COMPATIBILITY_HARNESS_VERSION,
    checkedAt: new Date().toISOString(),
    result: 'error',
    scope: 'compatibility',
    checks,
    log: 'scan-job-produced-no-result-artifact',
  })
}

const merged = new Map()
for (const row of previous.results) {
  if (registryMap.has(row.repository.toLocaleLowerCase())) merged.set(row.repository.toLocaleLowerCase(), row)
}
for (const [key, row] of received) merged.set(key, row)
const results = [...merged.values()].sort((left, right) => left.repository.localeCompare(right.repository))
const current = results.filter(row => registryMap.get(row.repository.toLocaleLowerCase())?.verifiedCommit === row.verifiedCommit)
const statuses = ['passed', 'partial', 'failed', 'timeout', 'unsupported', 'error']
const summary = Object.fromEntries(statuses.map(status => [status, current.filter(row => row.result === status).length]))
summary.pending = Math.max(0, registry.plugins.length - current.length)
const report = {
  schemaVersion: 1,
  policyVersion: COMPATIBILITY_POLICY_VERSION,
  generatedAt: received.size > 0 ? new Date().toISOString() : previous.generatedAt,
  total: results.length,
  summary,
  results,
}
await atomicJson(reportPath, report)
console.log(JSON.stringify({ merged: received.size, total: results.length, summary }, null, 2))

function sanitize(value) {
  return {
    repository: value.repository,
    verifiedCommit: value.verifiedCommit,
    packageName: value.packageName,
    version: value.version,
    profile: value.profile,
    harnessVersion: value.harnessVersion,
    checkedAt: value.checkedAt,
    result: value.result,
    scope: 'compatibility',
    checks: Object.fromEntries(COMPATIBILITY_CHECKS.map(name => [name, {
      status: value.checks[name].status,
      reason: value.checks[name].reason.slice(0, 500),
    }])),
    log: value.log.slice(-4000),
  }
}

async function jsonFiles(directory) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const files = []
  for (const entry of entries) {
    const resolved = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await jsonFiles(resolved)))
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(resolved)
  }
  return files.sort()
}

async function atomicJson(file, value) {
  const temporary = file + '.tmp'
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8')
  await rename(temporary, file)
}

function plainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function argument(name) {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
