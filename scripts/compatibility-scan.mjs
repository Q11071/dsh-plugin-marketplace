/** Install exact plugin sources without lifecycle scripts, then probe DSH in a no-network container. */

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import {
  COMPATIBILITY_HARNESS_VERSION,
  COMPATIBILITY_POLICY_VERSION,
  compatibilityResult,
  emptyChecks,
} from './compatibility-core.mjs'

const execute = promisify(execFile)
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const output = path.resolve(root, argument('--output') ?? '.compatibility-work/result.json')
const targets = parseTargets(process.env.COMPATIBILITY_BATCH_JSON ?? argument('--batch-json') ?? '[]')
const registry = JSON.parse(await readFile(path.join(root, 'registry', 'plugins.json'), 'utf8'))
const discovery = JSON.parse(await readFile(path.join(root, 'registry', 'discovery.json'), 'utf8'))
const registryMap = new Map(registry.plugins.map(plugin => [plugin.fullName.toLocaleLowerCase(), plugin]))
const categoryMap = new Map(discovery.plugins.map(row => [row.fullName.toLocaleLowerCase(), row.categories]))
const results = []

for (const target of targets) {
  const plugin = registryMap.get(target.repository.toLocaleLowerCase())
  validateTarget(target, plugin)
  results.push(await scanPlugin(plugin, categoryMap.get(plugin.fullName.toLocaleLowerCase()) ?? []))
}

await mkdir(path.dirname(output), { recursive: true })
await writeFile(output, JSON.stringify({
  schemaVersion: 1,
  policyVersion: COMPATIBILITY_POLICY_VERSION,
  results,
}, null, 2) + '\n', 'utf8')
console.log(JSON.stringify({
  scanned: results.length,
  statuses: Object.fromEntries([...new Set(results.map(row => row.result))].map(status => [status, results.filter(row => row.result === status).length])),
}, null, 2))

async function scanPlugin(plugin, categories) {
  const checkedAt = new Date().toISOString()
  const temporary = await mkdtemp(path.join(tmpdir(), 'dsh-compatibility-'))
  const base = {
    repository: plugin.fullName,
    verifiedCommit: plugin.verifiedCommit,
    packageName: plugin.packageName,
    version: plugin.version,
    profile: preferredProfile(plugin),
    harnessVersion: COMPATIBILITY_HARNESS_VERSION,
    checkedAt,
    scope: 'compatibility',
  }
  try {
    await mkdir(path.join(temporary, 'agent-workspace'), { recursive: true })
    await mkdir(path.join(temporary, 'user-home'), { recursive: true })
    const target = {
      ...base,
      install: plugin.install,
      hasClient: plugin.hasClient,
      agentCategory: categories.includes('agents'),
    }
    await writeFile(path.join(temporary, 'target.json'), JSON.stringify(target, null, 2) + '\n', 'utf8')
    const install = await installExactSource(temporary, target)
    if (install.status !== 'passed') {
      const checks = emptyChecks('install-did-not-complete')
      checks.install = { status: install.status, reason: install.reason }
      return { ...base, result: compatibilityResult(checks, install.infrastructure === true), checks, log: install.reason }
    }
    const probe = await runtimeProbe(temporary)
    const checks = { install, ...probe.checks }
    return {
      ...base,
      result: compatibilityResult(checks),
      checks,
      log: bounded(probe.log, 4000),
    }
  } catch (error) {
    const checks = emptyChecks('compatibility-infrastructure-error')
    checks.install = { status: 'inconclusive', reason: boundedReason(error) }
    return {
      ...base,
      result: compatibilityResult(checks, true),
      checks,
      log: boundedReason(error),
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

async function installExactSource(directory, target) {
  const script = [
    'set -eu',
    'mkdir -p /work/bin /work/corepack',
    'corepack enable --install-directory /work/bin',
    'corepack prepare pnpm@11.1.2 --activate',
    'export PATH=/work/bin:$PATH',
    'mkdir -p /work/runtime /work/dsh-home /work/baseline-home /work/agent-workspace /work/user-home',
    `printf '%s\\n' '{"private":true}' > /work/runtime/package.json`,
    'pnpm --dir /work/runtime add "@deepseek-ai/dsh@${DSH_VERSION}" "node-pty@1.1.0" --ignore-scripts',
    'pnpm --dir /work/runtime rebuild node-pty',
    'DSH_HOME=/work/baseline-home /work/runtime/node_modules/.bin/dsh plugin --profile "$PLUGIN_PROFILE" install --ignore-scripts',
    '/work/runtime/node_modules/.bin/dsh plugin --profile "$PLUGIN_PROFILE" add "$PLUGIN_SPEC" --ignore-scripts',
    'node /harness/compatibility-inspect.mjs',
    'if [ "$PLUGIN_SOURCE" = npm ]; then node /harness/compatibility-update.mjs; fi',
  ].join('\n')
  try {
    await docker([
      'run', '--rm', '--network=bridge', '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--user=' + dockerUser(),
      '--pids-limit=256', '--memory=1536m', '--cpus=2', '--workdir=/work',
      '--env', 'HOME=/work/user-home', '--env', 'COREPACK_HOME=/work/corepack',
      '--env', 'DSH_HOME=/work/dsh-home',
      '--env', 'DSH_VERSION=' + (process.env.DSH_COMPAT_VERSION ?? '0.1.0-rc.6'),
      '--env', 'PLUGIN_PROFILE=' + target.profile,
      '--env', 'PLUGIN_SPEC=' + target.install.spec,
      '--env', 'PLUGIN_SOURCE=' + target.install.source,
      '--env', 'PLUGIN_PACKAGE=' + target.packageName,
      '--env', 'PLUGIN_VERSION=' + target.version,
      '--volume=' + path.resolve(directory) + ':/work:rw',
      '--volume=' + path.join(root, 'scripts') + ':/harness:ro',
      image(), 'sh', '-c', script,
    ], 360_000)
    return { status: 'passed', reason: 'official-dsh-cli-installed-exact-source-with-lifecycle-scripts-disabled' }
  } catch (error) {
    const detail = fullOutput(error)
    if (/timed out|status 124|SIGKILL/i.test(detail)) return { status: 'timeout', reason: 'exact-source-install-timed-out' }
    if (/EAI_AGAIN|ENETUNREACH|ECONNRESET|ETIMEDOUT|ERR_PNPM_META_FETCH_FAIL|ERR_PNPM_FETCH|HTTP\s+(?:429|5\d\d)/i.test(detail)) {
      return { status: 'inconclusive', reason: 'package-download-infrastructure-error: ' + bounded(detail, 400), infrastructure: true }
    }
    return { status: 'failed', reason: 'exact-source-install-failed: ' + bounded(detail, 420) }
  }
}

async function runtimeProbe(directory) {
  try {
    await docker([
      'run', '--rm', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--pids-limit=128', '--memory=1024m', '--cpus=1', '--user=' + dockerUser(),
      '--workdir=/work/agent-workspace', '--tmpfs=/tmp:rw,noexec,nosuid,size=96m',
      '--env', 'HOME=/work/user-home', '--env', 'DSH_HOME=/work/dsh-home',
      '--volume=' + path.resolve(directory) + ':/work:rw',
      '--volume=' + path.join(root, 'scripts') + ':/harness:ro',
      image(), 'node', '/harness/compatibility-probe.mjs',
    ], 45_000)
  } catch (error) {
    const report = await readProbe(directory)
    if (report !== null) return report
    const detail = fullOutput(error)
    if (/timed out|status 124|SIGKILL/i.test(detail)) {
      const checks = emptyChecks('runtime-probe-timed-out')
      checks.hostLoad = { status: 'timeout', reason: 'runtime-probe-container-timed-out' }
      return { checks, log: bounded(detail, 4000) }
    }
    throw error
  }
  const report = await readProbe(directory)
  if (report === null) throw new Error('runtime probe produced no report')
  return report
}

function dockerUser() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000
  const gid = typeof process.getgid === 'function' ? process.getgid() : 1000
  return String(uid) + ':' + String(gid)
}

async function readProbe(directory) {
  try {
    return JSON.parse(await readFile(path.join(directory, 'runtime-probe.json'), 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function docker(args, timeout) {
  return execute('docker', args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 })
}

function validateTarget(target, plugin) {
  if (plugin === undefined
    || plugin.verifiedCommit !== target.verifiedCommit
    || plugin.packageName !== target.packageName
    || plugin.version !== target.version
    || plugin.install.mode !== 'automatic'
    || plugin.install.spec !== target.install?.spec) {
    throw new Error('compatibility target is not the current automatic Registry source: ' + String(target.repository))
  }
}

function parseTargets(value) {
  const parsed = JSON.parse(value)
  if (!Array.isArray(parsed) || parsed.length > 5) throw new Error('compatibility batch must be an array of at most five targets')
  return parsed
}

function preferredProfile(plugin) {
  if (plugin.install.profiles.includes('web')) return 'web'
  if (plugin.install.profiles.includes('headless')) return 'headless'
  return plugin.hasClient ? 'web' : (plugin.install.profiles[0] ?? 'headless')
}

function image() {
  return process.env.COMPATIBILITY_NODE_IMAGE ?? 'node:22-bookworm-slim'
}

function fullOutput(error) {
  return [error?.stderr, error?.stdout, error?.message].filter(value => typeof value === 'string' && value !== '').join(' | ')
}

function boundedReason(error) {
  return bounded(fullOutput(error) || String(error), 500)
}

function bounded(value, limit) {
  return String(value).replace(/[\r\t]+/g, ' ').slice(-limit)
}

function argument(name) {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
