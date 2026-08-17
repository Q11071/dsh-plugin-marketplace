/** Remove experimental security gates from the public Registry snapshot. */

import { readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assessGuidedInstall, promoteExactNpm } from './guided-audit-core.mjs'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const registryPath = path.join(root, 'registry', 'plugins.json')
const statePath = path.join(root, 'registry', 'state.json')
const reviewPath = path.join(root, 'registry', 'install-review.json')
const auditPath = path.join(root, 'registry', 'guided-audit.json')
const [registry, state, audit] = await Promise.all([
  json(registryPath),
  json(statePath),
  json(auditPath),
])

const securityReasons = new Set([
  'security-scan-pending-for-exact-commit',
  'security-scan-requires-manual-review',
  'security-scan-could-not-complete',
])
let restored = 0
for (const row of Object.values(state.repositories ?? {})) {
  if (!plainObject(row?.plugin) || !plainObject(row?.inspection)) continue
  const baseInstall = row.inspection.securityBaseInstall
  if (plainObject(baseInstall)) {
    row.plugin.install = baseInstall
    restored += 1
  }
  row.inspection.reviewReasons = Array.isArray(row.inspection.reviewReasons)
    ? row.inspection.reviewReasons.filter(reason => !securityReasons.has(reason))
    : []
  delete row.inspection.securityBaseInstall
}

const auditByName = new Map((audit.rows ?? []).map(row => [row.repository.toLocaleLowerCase(), row]))
let promoted = 0
for (const [key, row] of Object.entries(state.repositories ?? {})) {
  if (row?.status !== 'verified' || row.plugin?.install?.mode !== 'guided') continue
  const oldAudit = auditByName.get(key)
  if (oldAudit === undefined) continue
  const assessment = assessGuidedInstall(
    row.plugin,
    row.inspection,
    oldAudit.remoteCommands ?? [],
    oldAudit.npmVerification ?? { verified: false, reason: 'missing-audit-evidence' },
  )
  if (assessment.outcome !== 'automatic-npm-candidate') continue
  const result = promoteExactNpm(row.plugin, row, oldAudit.npmVerification)
  state.repositories[key] = result.stateRow
  promoted += 1
}

const plugins = Object.values(state.repositories ?? {})
  .filter(row => row?.status === 'verified' && plainObject(row.plugin))
  .map(row => row.plugin)
  .sort((left, right) => left.fullName.localeCompare(right.fullName))
const pluginsByName = new Map(plugins.map(plugin => [plugin.fullName.toLocaleLowerCase(), plugin]))
const guidedNames = new Set(plugins.filter(plugin => plugin.install.mode === 'guided')
  .map(plugin => plugin.fullName.toLocaleLowerCase()))
const rows = []
for (const oldAudit of audit.rows ?? []) {
  const key = oldAudit.repository.toLocaleLowerCase()
  if (!guidedNames.has(key)) continue
  const stateRow = state.repositories[key]
  const plugin = pluginsByName.get(key)
  const assessment = assessGuidedInstall(
    plugin,
    stateRow?.inspection,
    oldAudit.remoteCommands ?? [],
    oldAudit.npmVerification ?? { verified: false, reason: 'missing-audit-evidence' },
  )
  rows.push({
    ...oldAudit,
    assessment,
    current: {
      profiles: plugin.install.profiles,
      requiresBuildApproval: plugin.install.requiresBuildApproval,
      manualSteps: plugin.install.manualSteps,
      lifecycleScripts: stateRow?.inspection?.lifecycleScripts ?? [],
      runtimeArtifactsCommitted: stateRow?.inspection?.runtimeArtifactsCommitted ?? false,
      reviewReasons: stateRow?.inspection?.reviewReasons ?? [],
    },
  })
}
rows.sort((left, right) => left.repository.localeCompare(right.repository))

const generatedAt = new Date().toISOString()
const reviewRows = installReviewRows(state.repositories)
const groups = {}
for (const row of rows) {
  const group = row.remoteCommands?.length > 0
    ? 'remote-command-found'
    : row.commands?.length > 0
      ? 'local-or-unparsed-command-only'
      : 'no-install-command-found'
  groups[group] = (groups[group] ?? 0) + 1
}

registry.generatedAt = generatedAt
registry.plugins = plugins
state.generatedAt = generatedAt
await Promise.all([
  atomicJson(registryPath, registry),
  atomicJson(statePath, state),
  atomicJson(reviewPath, { schemaVersion: 1, generatedAt, repositories: reviewRows }),
  atomicJson(auditPath, { schemaVersion: 1, generatedAt, total: rows.length, groups, rows }),
])

console.log(JSON.stringify({ restored, promoted, automatic: plugins.length - guidedNames.size, guided: guidedNames.size }, null, 2))

function installReviewRows(repositories) {
  const rows = []
  for (const row of Object.values(repositories ?? {})) {
    if (row?.status !== 'verified' || !plainObject(row.plugin) || !plainObject(row.inspection)) continue
    const inspection = row.inspection
    const reviewReasons = Array.isArray(inspection.reviewReasons) ? inspection.reviewReasons : []
    const resolvedReasons = Array.isArray(inspection.resolvedReasons) ? inspection.resolvedReasons : []
    if (reviewReasons.length > 0) rows.push(reviewRow(row, 'needs-review', reviewReasons))
    else if (row.plugin.install.mode === 'automatic' && resolvedReasons.length > 0) {
      rows.push(reviewRow(row, 'auto-resolved', resolvedReasons))
    }
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

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function json(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

async function atomicJson(file, value) {
  const temporary = file + '.tmp'
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8')
  await rename(temporary, file)
}
