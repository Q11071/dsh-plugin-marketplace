/** Audit every guided Registry entry against its verified-commit README. */

import { readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assessGuidedInstall,
  installReviewRowFromState,
  promoteExactNpm,
} from './guided-audit-core.mjs'
import { verifyExactNpmRelease } from './npm-release.mjs'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const registry = JSON.parse(await readFile(path.join(root, 'registry', 'plugins.json'), 'utf8'))
const state = JSON.parse(await readFile(path.join(root, 'registry', 'state.json'), 'utf8'))
const installReview = JSON.parse(await readFile(path.join(root, 'registry', 'install-review.json'), 'utf8'))
const token = process.env.GITHUB_TOKEN?.trim()
if (!token) throw new Error('GITHUB_TOKEN is required for the guided audit')

const guided = registry.plugins.filter(plugin => plugin.install.mode === 'guided')
const audited = new Array(guided.length)
let cursor = 0
await Promise.all(Array.from({ length: Math.min(8, guided.length) }, async () => {
  for (;;) {
    const index = cursor++
    if (index >= guided.length) return
    audited[index] = await audit(guided[index])
  }
}))

// npm can become available between the Registry pass and this audit pass. In
// that case the old workflow produced an internally contradictory snapshot and
// failed verification. Reconcile the second exact-tarball proof into Registry
// state so one workflow run always converges on the strongest current evidence.
const rows = []
let promoted = 0
for (const row of audited) {
  if (row.assessment.outcome !== 'automatic-npm-candidate') {
    rows.push(row)
    continue
  }
  const key = row.repository.toLocaleLowerCase()
  const pluginIndex = registry.plugins.findIndex(plugin => plugin.fullName.toLocaleLowerCase() === key)
  const stateRow = state.repositories[key]
  if (pluginIndex < 0 || stateRow?.plugin === undefined || stateRow?.inspection === undefined) {
    throw new Error('guided audit could not reconcile Registry state for ' + row.repository)
  }
  const reconciled = promoteExactNpm(registry.plugins[pluginIndex], stateRow, row.npmVerification)
  registry.plugins[pluginIndex] = reconciled.plugin
  state.repositories[key] = reconciled.stateRow
  installReview.repositories = installReview.repositories.filter(item => item.repository.toLocaleLowerCase() !== key)
  installReview.repositories.push(installReviewRowFromState(reconciled.stateRow))
  promoted += 1
}

const groups = {}
for (const row of rows) {
  const key = row.remoteCommands.length > 0
    ? 'remote-command-found'
    : row.commands.length > 0
      ? 'local-or-unparsed-command-only'
      : 'no-install-command-found'
  groups[key] = (groups[key] ?? 0) + 1
}
const generatedAt = new Date().toISOString()
registry.generatedAt = generatedAt
state.generatedAt = generatedAt
installReview.generatedAt = generatedAt
installReview.repositories.sort((left, right) => left.repository.localeCompare(right.repository))
const report = { schemaVersion: 1, generatedAt, total: rows.length, groups, rows }
await Promise.all([
  atomicJson(path.join(root, 'registry', 'plugins.json'), registry),
  atomicJson(path.join(root, 'registry', 'state.json'), state),
  atomicJson(path.join(root, 'registry', 'install-review.json'), installReview),
  atomicJson(path.join(root, 'registry', 'guided-audit.json'), report),
])
console.log(JSON.stringify({ total: rows.length, promoted, groups }, null, 2))

async function audit(plugin) {
  const inspection = state.repositories[plugin.fullName.toLocaleLowerCase()]?.inspection ?? null
  const readme = await githubReadme(plugin.fullName, plugin.verifiedCommit)
  const commands = readme === null ? [] : installCommands(readme.text)
  const targetedCommands = commands.filter(command => targetsPlugin(command, plugin))
  const remoteCommands = targetedCommands.filter(command => command.source !== 'local' && command.source !== 'unknown')
  const npmVerification = await verifyExactNpmRelease(plugin, { userAgent: 'dsh-plugin-registry-audit' })
  const assessment = assessGuidedInstall(plugin, inspection, remoteCommands, npmVerification)
  return {
    repository: plugin.fullName,
    packageName: plugin.packageName,
    version: plugin.version,
    verifiedCommit: plugin.verifiedCommit,
    readmePath: readme?.path ?? null,
    commands,
    targetedCommands,
    remoteCommands,
    npmVerification,
    assessment,
    current: {
      profiles: plugin.install.profiles,
      requiresBuildApproval: plugin.install.requiresBuildApproval,
      manualSteps: plugin.install.manualSteps,
      lifecycleScripts: inspection?.lifecycleScripts ?? [],
      runtimeArtifactsCommitted: inspection?.runtimeArtifactsCommitted ?? false,
      reviewReasons: inspection?.reviewReasons ?? [],
    },
  }
}

async function githubReadme(repository, commit) {
  const url = 'https://api.github.com/repos/' + repository + '/readme?ref=' + commit
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let response
    try {
      response = await fetch(url, {
        headers: {
          accept: 'application/vnd.github.raw+json',
          authorization: 'Bearer ' + token,
          'user-agent': 'dsh-plugin-registry-audit',
          'x-github-api-version': '2022-11-28',
        },
        signal: AbortSignal.timeout(20_000),
      })
    } catch (error) {
      if (attempt === 3) throw new Error(repository + ' README request failed: ' + messageOf(error))
      await retryDelay(attempt)
      continue
    }
    if (response.status === 404) return null
    if (response.ok) return { path: response.headers.get('content-location'), text: await response.text() }
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500
    await response.body?.cancel()
    if (!retryable || attempt === 3) throw new Error(repository + ' README returned HTTP ' + response.status)
    await retryDelay(attempt)
  }
  throw new Error(repository + ' README retry budget exhausted')
}

function retryDelay(attempt) {
  return new Promise(resolve => setTimeout(resolve, 500 * (2 ** attempt)))
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function installCommands(text) {
  const normalized = text
    .replace(/\\\s*\r?\n\s*/g, ' ')
    .replace(/`\s*\r?\n\s*/g, ' ')
    .replace(/\^\s*\r?\n\s*/g, ' ')
  const results = []
  for (const line of normalized.split(/\r?\n/)) {
    if (!/\bdsh\s+plugin\b/i.test(line) || !/\badd\b/i.test(line)) continue
    const commandStart = line.search(/\bdsh\s+plugin\b/i)
    const raw = line.slice(commandStart).replace(/\s*(?:```|<\/?code>|<\/?pre>)\s*$/i, '').trim()
    const tokens = shellTokens(raw)
    const dsh = tokens.findIndex(token => token.toLocaleLowerCase() === 'dsh')
    const add = tokens.findIndex((token, index) => index > dsh && token.toLocaleLowerCase() === 'add')
    if (dsh < 0 || add < 0) continue
    let profile = null
    for (let index = dsh + 2; index < tokens.length; index += 1) {
      const token = tokens[index]
      if (/^--profile=/i.test(token)) profile = token.slice(token.indexOf('=') + 1)
      if (/^--profile$/i.test(token) && tokens[index + 1] !== undefined) profile = tokens[index + 1]
    }
    const spec = tokens.slice(add + 1).find((token, index, tail) => {
      if (token.startsWith('-')) return false
      const previous = tail[index - 1]
      return previous === undefined || !/^--profile$/i.test(previous)
    })?.replace(/[),.;]+$/, '') ?? ''
    if (spec === '') continue
    results.push({ raw: raw.slice(0, 500), profile, spec, source: installSource(spec) })
  }
  return unique(results)
}

function shellTokens(value) {
  const tokens = []
  const expression = /"([^"]*)"|'([^']*)'|([^\s`]+)/g
  for (const match of value.matchAll(expression)) tokens.push(match[1] ?? match[2] ?? match[3] ?? '')
  return tokens
}

function installSource(spec) {
  if (/^(?:file:|link:|\.{1,2}(?:[\\/]|$)|[A-Za-z]:[\\/]|\/)/.test(spec)) return 'local'
  if (/^https:\/\/.+\.tgz(?:[?#].*)?$/i.test(spec)) return 'tarball'
  if (/^(?:github:|git\+https:\/\/github\.com\/|https:\/\/github\.com\/|[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*(?:#.*)?)$/i.test(spec)) return 'github'
  if (/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(?:@[^\s]+)?$/i.test(spec)) return 'npm'
  return 'unknown'
}

function targetsPlugin(command, plugin) {
  if (command.source === 'npm') return npmName(command.spec).toLocaleLowerCase() === plugin.packageName.toLocaleLowerCase()
  if (command.source === 'github') return githubRepository(command.spec)?.toLocaleLowerCase() === plugin.fullName.toLocaleLowerCase()
  if (command.source === 'tarball') {
    const basename = new URL(command.spec).pathname.split('/').pop()?.toLocaleLowerCase() ?? ''
    const unscoped = plugin.packageName.split('/').pop().toLocaleLowerCase()
    return basename.includes(unscoped)
  }
  return false
}

function npmName(spec) {
  if (spec.startsWith('@')) {
    const separator = spec.indexOf('@', 1)
    return separator < 0 ? spec : spec.slice(0, separator)
  }
  const separator = spec.indexOf('@')
  return separator < 0 ? spec : spec.slice(0, separator)
}

function githubRepository(spec) {
  const match = /^(?:github:|git\+https:\/\/github\.com\/|https:\/\/github\.com\/)?([^/#&]+\/[^/#&]+)(?:[&#].*)?$/i.exec(spec)
  return match?.[1]?.replace(/\.git$/i, '') ?? null
}

function unique(rows) {
  return [...new Map(rows.map(row => [JSON.stringify(row), row])).values()]
}

async function atomicJson(file, value) {
  const temporary = file + '.tmp'
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8')
  await rename(temporary, file)
}
