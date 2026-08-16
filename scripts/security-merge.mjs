/** Merge unprivileged scan artifacts into the central exact-commit report. */

import { appendFile, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  applySecurityGate,
  SECURITY_POLICY_VERSION,
  SECURITY_SCANNER_VERSION,
  validSecurityReportRoot,
  validSecurityResult,
} from './security-core.mjs'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const planPath = path.resolve(root, argument('--plan') ?? '.security-results/plan/plan.json')
const resultsDirectory = path.resolve(root, argument('--results') ?? '.security-results/scans')
const registryPath = path.resolve(root, argument('--registry') ?? 'registry/plugins.json')
const reportPath = path.resolve(root, argument('--report') ?? 'registry/security-report.json')
const statePath = path.resolve(root, argument('--state') ?? 'registry/state.json')
const installReviewPath = path.resolve(root, argument('--install-review') ?? 'registry/install-review.json')
const plan = JSON.parse(await readFile(planPath, 'utf8'))
const registry = JSON.parse(await readFile(registryPath, 'utf8'))
const state = JSON.parse(await readFile(statePath, 'utf8'))
const installReview = JSON.parse(await readFile(installReviewPath, 'utf8'))
const previous = JSON.parse(await readFile(reportPath, 'utf8'))

if (!plainObject(plan) || plan.schemaVersion !== 1 || !Array.isArray(plan.selected)) throw new Error('security plan is invalid')
if (!validSecurityReportRoot(previous)) throw new Error('previous security report is invalid')
const registryMap = new Map(registry.plugins.map(plugin => [plugin.fullName.toLocaleLowerCase(), plugin]))
const planned = new Map()
for (const target of plan.selected) {
  const plugin = registryMap.get(target.repository?.toLocaleLowerCase())
  if (plugin === undefined || plugin.verifiedCommit !== target.verifiedCommit) {
    throw new Error('security plan no longer matches Registry: ' + String(target.repository))
  }
  planned.set(target.repository.toLocaleLowerCase(), target)
}

const received = new Map()
for (const file of await jsonFiles(resultsDirectory)) {
  const artifact = JSON.parse(await readFile(file, 'utf8'))
  if (!plainObject(artifact)
    || artifact.schemaVersion !== 1
    || artifact.policyVersion !== SECURITY_POLICY_VERSION
    || !Array.isArray(artifact.results)) {
    throw new Error('invalid security result artifact: ' + file)
  }
  for (const candidate of artifact.results) {
    if (!validSecurityResult(candidate)) throw new Error('invalid security result for ' + String(candidate?.repository))
    const key = candidate.repository.toLocaleLowerCase()
    const target = planned.get(key)
    if (target === undefined || target.verifiedCommit !== candidate.verifiedCommit) {
      throw new Error('unplanned security result: ' + candidate.repository)
    }
    if (received.has(key)) throw new Error('duplicate security result: ' + candidate.repository)
    received.set(key, sanitizeResult(candidate))
  }
}

for (const [key, target] of planned) {
  if (received.has(key)) continue
  const plugin = registryMap.get(key)
  received.set(key, {
    repository: plugin.fullName,
    verifiedCommit: target.verifiedCommit,
    packageName: plugin.packageName,
    version: plugin.version,
    scannerVersion: SECURITY_SCANNER_VERSION,
    scannedAt: new Date().toISOString(),
    status: 'error',
    riskScore: 0,
    static: { scannedFiles: 0, scannedBytes: 0, archiveFiles: 0, archiveBytes: 0, findings: [], truncatedFindings: false },
    sandbox: { status: 'skipped', reason: 'scan-job-produced-no-result-artifact' },
  })
}

const merged = new Map()
for (const row of previous.results) {
  const key = row.repository.toLocaleLowerCase()
  if (registryMap.has(key)) merged.set(key, row)
}
for (const [key, row] of received) merged.set(key, row)
const results = [...merged.values()].sort((left, right) => left.repository.localeCompare(right.repository))
const currentResults = results.filter(row => registryMap.get(row.repository.toLocaleLowerCase())?.verifiedCommit === row.verifiedCommit)
const summary = {
  passed: currentResults.filter(row => row.status === 'passed').length,
  review: currentResults.filter(row => row.status === 'review').length,
  error: currentResults.filter(row => row.status === 'error').length,
  pending: Math.max(0, registry.plugins.length - currentResults.length),
}
const report = {
  schemaVersion: 1,
  policyVersion: SECURITY_POLICY_VERSION,
  generatedAt: received.size > 0 ? new Date().toISOString() : previous.generatedAt,
  enforcementStartedAt: previous.enforcementStartedAt,
  total: results.length,
  summary,
  results,
}
let gateChanges = 0
for (const [key, row] of Object.entries(state.repositories)) {
  const gated = applySecurityGate(row, report)
  if (JSON.stringify(gated) !== JSON.stringify(row)) gateChanges += 1
  state.repositories[key] = gated
}
if (gateChanges > 0) {
  const generatedAt = new Date().toISOString()
  state.generatedAt = generatedAt
  registry.generatedAt = generatedAt
  registry.plugins = Object.values(state.repositories)
    .filter(row => plainObject(row) && row.status === 'verified' && plainObject(row.plugin))
    .map(row => row.plugin)
    .sort((left, right) => left.fullName.localeCompare(right.fullName))
  installReview.generatedAt = generatedAt
  installReview.repositories = installReviewRows(state.repositories)
}
await Promise.all([
  atomicJson(reportPath, report),
  ...(gateChanges === 0 ? [] : [
    atomicJson(statePath, state),
    atomicJson(registryPath, registry),
    atomicJson(installReviewPath, installReview),
  ]),
])
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, 'gate_changes=' + String(gateChanges) + '\n', 'utf8')
}
console.log(JSON.stringify({ merged: received.size, gateChanges, total: results.length, summary }, null, 2))

function sanitizeResult(value) {
  return {
    repository: value.repository,
    verifiedCommit: value.verifiedCommit,
    packageName: value.packageName,
    version: value.version,
    scannerVersion: value.scannerVersion ?? SECURITY_SCANNER_VERSION,
    scannedAt: value.scannedAt,
    status: value.status,
    riskScore: value.riskScore,
    static: {
      scannedFiles: value.static.scannedFiles,
      scannedBytes: value.static.scannedBytes,
      archiveFiles: integer(value.static.archiveFiles),
      archiveBytes: integer(value.static.archiveBytes),
      findings: value.static.findings.map(finding => ({
        rule: finding.rule,
        severity: finding.severity,
        path: finding.path,
        line: finding.line,
        ...(finding.detail === undefined ? {} : { detail: finding.detail }),
      })),
      truncatedFindings: value.static.truncatedFindings === true,
    },
    sandbox: {
      status: value.sandbox.status,
      reason: value.sandbox.reason.slice(0, 500),
    },
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

function integer(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0
}

function installReviewRows(repositories) {
  const rows = []
  for (const row of Object.values(repositories)) {
    if (!plainObject(row) || row.status !== 'verified' || !plainObject(row.plugin) || !plainObject(row.inspection)) continue
    const inspection = row.inspection
    const reasons = Array.isArray(inspection.reviewReasons) ? inspection.reviewReasons : []
    const resolved = Array.isArray(inspection.resolvedReasons) ? inspection.resolvedReasons : []
    if (reasons.length > 0) rows.push(reviewRow(row, 'needs-review', reasons))
    else if (row.plugin.install?.mode === 'automatic' && resolved.length > 0) rows.push(reviewRow(row, 'auto-resolved', resolved))
  }
  return rows.sort((left, right) => left.repository.localeCompare(right.repository))
}

function reviewRow(row, status, reasons) {
  return {
    repository: row.repository,
    status,
    mode: row.plugin.install.mode,
    reasons,
    profiles: row.inspection.profiles,
    profileSource: row.inspection.profileSource,
    lifecycleScripts: row.inspection.lifecycleScripts,
    runtimeArtifactsCommitted: row.inspection.runtimeArtifactsCommitted,
    artifactGroups: row.inspection.artifactGroups,
    readme: row.inspection.readme,
    checkedAt: row.checkedAt,
  }
}

function argument(name) {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
