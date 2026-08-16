/** Persist a resumable full-scan checkpoint and expose continuation outputs. */

import { appendFile, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { advanceFullScan, fullScanCounts, validFullScanState } from './full-scan-core.mjs'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const registryPath = resolvePath('--registry', 'registry/plugins.json')
const registryStatePath = resolvePath('--registry-state', 'registry/state.json')
const securityPath = resolvePath('--security', 'registry/security-report.json')
const compatibilityPath = resolvePath('--compatibility', 'registry/compatibility-report.json')
const statePath = resolvePath('--state', 'registry/full-scan-state.json')
const registry = await json(registryPath)
const registryState = await json(registryStatePath)
const security = await json(securityPath)
const compatibility = await json(compatibilityPath)
const previous = await optionalJson(statePath)
const counts = fullScanCounts(registry, security, compatibility, registryState)
const rateRemaining = optionalNonNegativeInteger(process.env.FULL_SCAN_RATE_REMAINING, 'rate remaining')
const rateResetAt = unixDate(process.env.FULL_SCAN_RATE_RESET)
const result = advanceFullScan({
  counts,
  previous,
  sessionId: process.env.FULL_SCAN_SESSION || process.env.GITHUB_RUN_ID || 'local-full-scan',
  wave: nonNegativeInteger(process.env.FULL_SCAN_WAVE ?? '0', 'wave'),
  runId: process.env.GITHUB_RUN_ID ?? '',
  rateRemaining,
  rateMinimum: nonNegativeInteger(process.env.FULL_SCAN_RATE_MINIMUM ?? '750', 'rate minimum'),
  rateResetAt,
  maxWaves: positiveInteger(process.env.FULL_SCAN_MAX_WAVES ?? '50', 'max waves'),
})

if (!validFullScanState(result.state)) throw new Error('generated full scan state is invalid')
await writeFile(statePath, JSON.stringify(result.state, null, 2) + '\n', 'utf8')

if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT,
    'session_id=' + result.state.sessionId + '\n'
    + 'status=' + result.state.status + '\n'
    + 'pause_reason=' + (result.state.pauseReason ?? '') + '\n'
    + 'should_continue=' + String(result.shouldContinue) + '\n'
    + 'next_wave=' + String(result.nextWave) + '\n'
    + 'security_pending=' + String(counts.security.pending) + '\n'
    + 'compatibility_pending=' + String(counts.compatibility.pending) + '\n'
    + 'remaining_work=' + String(counts.remainingWork) + '\n',
  'utf8')
}

if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY,
    '### Full Registry scan\n\n'
    + `- Session: \`${result.state.sessionId}\`\n`
    + `- Wave: ${result.state.wave}\n`
    + `- Status: **${result.state.status}**\n`
    + `- Security pending: ${counts.security.pending}\n`
    + `- Compatibility pending: ${counts.compatibility.pending}\n`
    + `- Remaining work units: ${counts.remainingWork}\n`
    + (result.state.pauseReason ? `- Pause reason: \`${result.state.pauseReason}\`\n` : ''),
  'utf8')
}

console.log(JSON.stringify(result, null, 2))

function resolvePath(flag, fallback) {
  const index = process.argv.indexOf(flag)
  return path.resolve(root, index < 0 ? fallback : process.argv[index + 1])
}

async function json(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

async function optionalJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

function positiveInteger(value, label) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(label + ' must be a positive integer')
  return parsed
}

function nonNegativeInteger(value, label) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(label + ' must be a non-negative integer')
  return parsed
}

function optionalNonNegativeInteger(value, label) {
  if (value === undefined || value === '') return null
  return nonNegativeInteger(value, label)
}

function unixDate(value) {
  if (value === undefined || value === '') return null
  const seconds = nonNegativeInteger(value, 'rate reset')
  return new Date(seconds * 1000).toISOString()
}
