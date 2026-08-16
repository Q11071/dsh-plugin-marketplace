/**
 * Scan exact GitHub commits without evaluating source on the Actions host.
 * Optional runtime import happens inside a no-network, read-only Docker sandbox.
 */

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { promisify } from 'node:util'
import { createGunzip } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import tar from 'tar-stream'
import { analyzePluginFiles, SECURITY_POLICY_VERSION } from './security-core.mjs'

const execute = promisify(execFile)
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const output = path.resolve(root, argument('--output') ?? '.security-work/result.json')
const targets = parseTargets(process.env.SECURITY_BATCH_JSON ?? argument('--batch-json') ?? '[]')
const registry = JSON.parse(await readFile(path.join(root, 'registry', 'plugins.json'), 'utf8'))
const registryMap = new Map(registry.plugins.map(plugin => [plugin.fullName.toLocaleLowerCase(), plugin]))
const results = []

for (const target of targets) {
  const plugin = registryMap.get(target.repository.toLocaleLowerCase())
  if (plugin === undefined || plugin.verifiedCommit !== target.verifiedCommit) {
    throw new Error('security target is not the current Registry commit: ' + target.repository)
  }
  results.push(await scanPlugin(plugin))
}

await mkdir(path.dirname(output), { recursive: true })
await writeFile(output, JSON.stringify({ schemaVersion: 1, policyVersion: SECURITY_POLICY_VERSION, results }, null, 2) + '\n', 'utf8')
console.log(JSON.stringify({
  scanned: results.length,
  passed: results.filter(row => row.status === 'passed').length,
  review: results.filter(row => row.status === 'review').length,
  error: results.filter(row => row.status === 'error').length,
}, null, 2))

async function scanPlugin(plugin) {
  const scannedAt = new Date().toISOString()
  const temporary = await mkdtemp(path.join(tmpdir(), 'dsh-security-'))
  try {
    const snapshot = await downloadSnapshot(plugin, temporary)
    const manifest = JSON.parse(await readFile(path.join(temporary, 'package.json'), 'utf8'))
    if (manifest.name !== plugin.packageName || manifest.version !== plugin.version) {
      throw new Error('exact commit package identity differs from Registry')
    }
    const analysis = analyzePluginFiles(snapshot.scannableFiles, manifest)
    const entry = runtimeEntry(manifest)
    const syntax = await syntaxCheck(temporary, entry)
    const sandbox = analysis.status === 'review'
      ? { status: 'skipped', reason: 'static-review-required-before-runtime-import' }
      : syntax.status === 'failed'
        ? syntax
        : process.env.SECURITY_SANDBOX === '1'
          ? await sandboxImport(temporary, entry)
          : { status: 'skipped', reason: 'sandbox-not-requested' }
    return {
      repository: plugin.fullName,
      verifiedCommit: plugin.verifiedCommit,
      packageName: plugin.packageName,
      version: plugin.version,
      scannedAt,
      status: analysis.status,
      riskScore: analysis.riskScore,
      static: {
        scannedFiles: analysis.scannedFiles,
        scannedBytes: analysis.scannedBytes,
        archiveFiles: snapshot.archiveFiles,
        archiveBytes: snapshot.archiveBytes,
        findings: analysis.findings,
        truncatedFindings: analysis.truncatedFindings,
      },
      sandbox,
    }
  } catch (error) {
    return {
      repository: plugin.fullName,
      verifiedCommit: plugin.verifiedCommit,
      packageName: plugin.packageName,
      version: plugin.version,
      scannedAt,
      status: 'error',
      riskScore: 0,
      static: { scannedFiles: 0, scannedBytes: 0, archiveFiles: 0, archiveBytes: 0, findings: [], truncatedFindings: false },
      sandbox: { status: 'skipped', reason: boundedReason(error) },
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

async function downloadSnapshot(plugin, destination) {
  const [owner, repository] = plugin.fullName.split('/')
  const url = new URL('https://codeload.github.com/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repository)
    + '/tar.gz/' + plugin.verifiedCommit)
  let response
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      response = await fetch(url, {
        headers: { 'user-agent': 'dsh-plugin-security-scanner' },
        signal: AbortSignal.timeout(60_000),
      })
      if (response.ok || (response.status < 500 && response.status !== 429)) break
      await response.body?.cancel()
    } catch (error) {
      if (attempt === 2) throw error
    }
    await new Promise(resolve => setTimeout(resolve, 500 * (2 ** attempt)))
  }
  if (!response?.ok) throw new Error('GitHub snapshot returned HTTP ' + String(response?.status ?? 'unknown'))
  const compressed = await boundedBytes(response, 50 * 1024 * 1024)
  return await extractSnapshot(compressed, destination)
}

async function extractSnapshot(compressed, destination) {
  const extractor = tar.extract()
  const completed = pipeline(Readable.from([compressed]), createGunzip(), extractor)
  const scannableFiles = []
  let archiveFiles = 0
  let archiveBytes = 0
  try {
    for await (const entry of extractor) {
      const header = entry.header
      const relative = safeSnapshotPath(header.name)
      const size = typeof header.size === 'number' ? header.size : 0
      if (relative === null || (header.type !== 'file' && header.type !== 'contiguous-file')) {
        entry.resume()
        continue
      }
      archiveFiles += 1
      archiveBytes += size
      if (archiveFiles > 20_000) throw new Error('snapshot contains more than 20,000 files')
      if (archiveBytes > 200 * 1024 * 1024) throw new Error('snapshot expands beyond 200 MiB')
      if (size > 25 * 1024 * 1024) throw new Error('snapshot file exceeds 25 MiB: ' + relative)
      const bytes = await streamBytes(entry, size)
      const target = path.join(destination, ...relative.split('/'))
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, bytes, { mode: 0o644 })
      if (bytes.length <= 1024 * 1024 && shouldInspect(relative, bytes)) {
        scannableFiles.push({ path: relative, bytes })
      }
    }
    await completed
  } catch (error) {
    extractor.destroy(error instanceof Error ? error : new Error(String(error)))
    await completed.catch(() => undefined)
    throw error
  }
  if (archiveFiles === 0) throw new Error('snapshot archive is empty')
  return { archiveFiles, archiveBytes, scannableFiles }
}

async function syntaxCheck(directory, entry) {
  if (entry === null) return { status: 'inconclusive', reason: 'runtime-entry-could-not-be-resolved' }
  if (!/\.(?:cjs|js|mjs)$/i.test(entry)) return { status: 'inconclusive', reason: 'runtime-entry-is-not-javascript' }
  try {
    await execute(process.execPath, ['--check', path.join(directory, ...entry.split('/'))], {
      timeout: 15_000,
      windowsHide: true,
      maxBuffer: 256 * 1024,
    })
    return { status: 'passed', reason: 'runtime-entry-syntax-valid' }
  } catch (error) {
    return { status: 'failed', reason: 'runtime-entry-syntax-invalid: ' + boundedReason(error) }
  }
}

async function sandboxImport(directory, entry) {
  if (entry === null) return { status: 'inconclusive', reason: 'runtime-entry-could-not-be-resolved' }
  const name = 'dsh-security-' + randomBytes(8).toString('hex')
  const mount = path.resolve(directory) + ':/plugin:ro'
  const fileUrl = 'file:///plugin/' + entry.split('/').map(encodeURIComponent).join('/')
  const probe = 'import(' + JSON.stringify(fileUrl) + ').then(() => process.exit(0))'
  const args = [
    'run', '--name', name, '--rm', '--network=none', '--read-only',
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128',
    '--memory=512m', '--cpus=1', '--user=65534:65534', '--workdir=/plugin',
    '--tmpfs=/tmp:rw,noexec,nosuid,size=64m', '--env=HOME=/tmp', '--volume=' + mount,
    'node:22-bookworm-slim', 'timeout', '--signal=KILL', '20s',
    'node', '--input-type=module', '--eval', probe,
  ]
  try {
    await execute('docker', args, { timeout: 30_000, windowsHide: true, maxBuffer: 512 * 1024 })
    return { status: 'passed', reason: 'entry-imported-in-no-network-read-only-sandbox' }
  } catch (error) {
    const detail = boundedReason(error)
    if (/Cannot find package|ERR_MODULE_NOT_FOUND|Cannot find module/i.test(detail)) {
      return { status: 'inconclusive', reason: 'sandbox-missing-runtime-dependency' }
    }
    if (/ENOENT|not recognized|not found/i.test(detail) && /docker/i.test(detail)) {
      return { status: 'unavailable', reason: 'docker-is-unavailable' }
    }
    if (/timed out|status 124|SIGKILL/i.test(detail)) {
      return { status: 'failed', reason: 'sandbox-runtime-timeout' }
    }
    return { status: 'failed', reason: 'sandbox-import-failed: ' + detail }
  } finally {
    await execute('docker', ['rm', '--force', name], { timeout: 10_000, windowsHide: true }).catch(() => undefined)
  }
}

function runtimeEntry(manifest) {
  const exportsValue = manifest.exports
  let value
  if (typeof exportsValue === 'string') value = exportsValue
  else if (plainObject(exportsValue)) value = exportsValue['.'] ?? exportsValue.default ?? exportsValue.import ?? exportsValue.require
  const resolved = conditionalEntry(value) ?? (typeof manifest.main === 'string' ? manifest.main : null)
  if (resolved === null) return null
  const normalized = resolved.replace(/^\.\//, '').replace(/\\/g, '/')
  if (!safeRelativePath(normalized)) return null
  return normalized
}

function conditionalEntry(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(conditionalEntry).find(Boolean) ?? null
  if (!plainObject(value)) return null
  for (const key of ['node', 'import', 'require', 'default']) {
    const candidate = conditionalEntry(value[key])
    if (candidate !== null) return candidate
  }
  return null
}

function safeSnapshotPath(value) {
  if (typeof value !== 'string' || value.includes('\0') || value.includes('\\')) return null
  const parts = value.replace(/^\.\//, '').split('/')
  if (parts.length < 2) return null
  const stripped = parts.slice(1)
  if (stripped.length === 0 || stripped.some(part => part === '' || part === '.' || part === '..')) return null
  const result = stripped.join('/')
  return safeRelativePath(result) ? result : null
}

function safeRelativePath(value) {
  return value !== ''
    && !value.startsWith('/')
    && !/^[A-Za-z]:/.test(value)
    && !value.split('/').includes('..')
}

function shouldInspect(filePath, bytes) {
  const lower = filePath.toLocaleLowerCase()
  if (/(?:^|\/)(?:package|npm-shrinkwrap)\.json$/.test(lower)) return true
  if (/\.(?:cjs|cmd|dll|dylib|exe|js|jsx|mjs|node|ps1|sh|so|ts|tsx)$/.test(lower)) return true
  return bytes.length >= 4 && ((bytes[0] === 0x4d && bytes[1] === 0x5a) || bytes[0] === 0x7f)
}

async function boundedBytes(response, maximum) {
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > maximum) throw new Error('snapshot download exceeds 50 MiB')
  if (response.body === null) throw new Error('snapshot returned no body')
  const reader = response.body.getReader()
  const chunks = []
  let length = 0
  for (;;) {
    const part = await reader.read()
    if (part.done) break
    length += part.value.byteLength
    if (length > maximum) {
      await reader.cancel()
      throw new Error('snapshot download exceeds 50 MiB')
    }
    chunks.push(Buffer.from(part.value.buffer, part.value.byteOffset, part.value.byteLength))
  }
  return Buffer.concat(chunks, length)
}

async function streamBytes(stream, expected) {
  const chunks = []
  let length = 0
  for await (const chunk of stream) {
    length += chunk.length
    if (length > expected || length > 25 * 1024 * 1024) throw new Error('archive entry exceeds declared size')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, length)
}

function parseTargets(value) {
  const parsed = JSON.parse(value)
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 20) throw new Error('security batch must contain 1 to 20 targets')
  const seen = new Set()
  for (const row of parsed) {
    if (!plainObject(row) || !/^[\w.-]+\/[\w.-]+$/.test(row.repository ?? '') || !/^[0-9a-f]{40}$/i.test(row.verifiedCommit ?? '')) {
      throw new Error('security batch contains an invalid target')
    }
    const key = row.repository.toLocaleLowerCase()
    if (seen.has(key)) throw new Error('security batch repeats ' + row.repository)
    seen.add(key)
  }
  return parsed
}

function boundedReason(error) {
  const output = [error?.message, error?.stderr, error?.stdout].filter(value => typeof value === 'string' && value !== '').join(' | ')
  return output.replace(/[\r\n\t]+/g, ' ').slice(0, 500) || String(error).slice(0, 500)
}

function argument(name) {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
