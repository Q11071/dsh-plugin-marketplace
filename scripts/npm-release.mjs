/** Static verification for an exact npm release. No package code is executed. */

import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import tar from 'tar-stream'
import {
  InvalidCandidateError,
  MAX_MANIFEST_BYTES,
  MAX_PATCH_BYTES,
  RetryCandidateError,
  validateBundlePatch,
  validateManifest,
} from './registry-core.mjs'

const MAX_TARBALL_BYTES = 50 * 1024 * 1024
const MAX_UNPACKED_BYTES = 150 * 1024 * 1024
const NPM_HOST = 'registry.npmjs.org'

/**
 * Prove that packageName@version is a self-contained DSH bundle in npm.
 * Registry metadata alone is insufficient: the integrity-pinned tarball is
 * downloaded and its manifest, patch and runtime entry files are inspected.
 */
export async function verifyExactNpmRelease(expected, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const userAgent = options.userAgent ?? 'dsh-plugin-registry'
  const spec = expected.packageName + '@' + expected.version
  const metadataUrl = new URL(
    'https://' + NPM_HOST + '/' + encodeURIComponent(expected.packageName) + '/' + encodeURIComponent(expected.version),
  )
  let response
  try {
    response = await fetchImpl(metadataUrl, {
      headers: { accept: 'application/json', 'user-agent': userAgent },
      signal: AbortSignal.timeout(20_000),
    })
  } catch (error) {
    throw new RetryCandidateError('npm metadata request failed for ' + spec + ': ' + messageOf(error))
  }
  if (response.status === 404) return rejected(spec, 'npm-version-not-published')
  if (response.status === 403 || response.status === 429 || response.status >= 500) {
    throw new RetryCandidateError('npm metadata returned HTTP ' + String(response.status) + ' for ' + spec)
  }
  if (!response.ok) return rejected(spec, 'npm-metadata-http-' + String(response.status))

  let metadata
  try {
    metadata = await response.json()
  } catch {
    throw new RetryCandidateError('npm metadata is not JSON for ' + spec)
  }
  if (!plainObject(metadata) || metadata.name !== expected.packageName || metadata.version !== expected.version) {
    return rejected(spec, 'npm-metadata-identity-mismatch')
  }
  const integrity = plainObject(metadata.dist) ? metadata.dist.integrity : undefined
  const tarballValue = plainObject(metadata.dist) ? metadata.dist.tarball : undefined
  if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) {
    return rejected(spec, 'npm-release-has-no-sha512-integrity')
  }
  let tarballUrl
  try {
    tarballUrl = new URL(tarballValue)
  } catch {
    return rejected(spec, 'npm-release-has-invalid-tarball-url')
  }
  if (tarballUrl.protocol !== 'https:' || tarballUrl.hostname !== NPM_HOST) {
    return rejected(spec, 'npm-tarball-is-not-on-the-official-registry')
  }

  let tarballResponse
  try {
    tarballResponse = await fetchImpl(tarballUrl, {
      headers: { accept: 'application/octet-stream', 'user-agent': userAgent },
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    throw new RetryCandidateError('npm tarball request failed for ' + spec + ': ' + messageOf(error))
  }
  if (tarballResponse.status === 403 || tarballResponse.status === 429 || tarballResponse.status >= 500) {
    throw new RetryCandidateError('npm tarball returned HTTP ' + String(tarballResponse.status) + ' for ' + spec)
  }
  if (!tarballResponse.ok) return rejected(spec, 'npm-tarball-http-' + String(tarballResponse.status))
  let bytes
  try {
    bytes = await boundedBytes(tarballResponse, MAX_TARBALL_BYTES, spec + ' tarball')
  } catch (error) {
    if (error instanceof InvalidCandidateError) return rejected(spec, 'npm-tarball-invalid', error.message)
    throw error
  }
  const actualIntegrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64')
  if (actualIntegrity !== integrity) return rejected(spec, 'npm-tarball-integrity-mismatch')

  let archive
  try {
    archive = await inspectTarball(bytes, expected.bundlePatch)
  } catch (error) {
    if (error instanceof InvalidCandidateError) return rejected(spec, 'npm-tarball-invalid', error.message)
    throw new RetryCandidateError('could not inspect npm tarball for ' + spec + ': ' + messageOf(error))
  }
  if (archive.manifestText === null) return rejected(spec, 'npm-tarball-has-no-package-json')
  let identity
  try {
    identity = validateManifest(archive.manifestText)
  } catch (error) {
    return rejected(spec, 'npm-manifest-invalid', messageOf(error))
  }
  if (identity.packageName !== expected.packageName || identity.version !== expected.version) {
    return rejected(spec, 'npm-tarball-identity-mismatch')
  }
  if (identity.bundlePatch !== expected.bundlePatch) return rejected(spec, 'npm-bundle-patch-mismatch')
  const hardLifecycleScripts = identity.installHints.lifecycleScripts.filter(name => name !== 'prepare')
  if (hardLifecycleScripts.length > 0) {
    return rejected(spec, 'npm-hard-lifecycle-scripts', hardLifecycleScripts.join(', '))
  }
  // npm synthesizes `node-gyp rebuild` at install time for a root
  // binding.gyp even when package.json has no explicit install script.
  if (archive.paths.has('binding.gyp')) return rejected(spec, 'npm-native-build-script')
  if (archive.patchText === null) return rejected(spec, 'npm-tarball-has-no-bundle-patch')
  try {
    validateBundlePatch(archive.patchText, expected.packageName)
  } catch (error) {
    return rejected(spec, 'npm-bundle-patch-invalid', messageOf(error))
  }
  const artifactGroups = identity.installHints.runtimeEntryGroups.map(group => ({
    label: group.label,
    paths: group.paths,
    found: group.paths.find(candidate => archive.paths.has(normalizePackagePath(candidate))) ?? null,
  }))
  if (artifactGroups.length === 0 || artifactGroups.some(group => group.found === null)) {
    return rejected(spec, 'npm-runtime-entry-artifacts-missing', JSON.stringify(artifactGroups))
  }
  return {
    verified: true,
    reason: 'exact-npm-tarball-verified',
    spec,
    integrity,
    tarball: tarballUrl.href,
    gitHead: typeof metadata.gitHead === 'string' && /^[0-9a-f]{40}$/i.test(metadata.gitHead)
      ? metadata.gitHead
      : null,
    artifactGroups,
  }
}

async function inspectTarball(bytes, expectedPatchPath) {
  const extractor = tar.extract()
  const paths = new Set()
  let manifestText = null
  let patchText = null
  let unpacked = 0
  const expectedPatch = normalizePackagePath(expectedPatchPath)
  const completed = pipeline(Readable.from([bytes]), createGunzip(), extractor)
  try {
    for await (const entry of extractor) {
      const header = entry.header
      const normalized = safeArchivePath(header.name)
      const size = typeof header.size === 'number' ? header.size : 0
      unpacked += size
      if (unpacked > MAX_UNPACKED_BYTES) throw new InvalidCandidateError('npm tarball expands beyond the safety limit')
      if (normalized === null || (header.type !== 'file' && header.type !== 'contiguous-file')) {
        entry.resume()
        continue
      }
      paths.add(normalized)
      const maximum = normalized === 'package.json'
        ? MAX_MANIFEST_BYTES
        : normalized === expectedPatch
          ? MAX_PATCH_BYTES
          : 0
      if (maximum === 0) {
        entry.resume()
        continue
      }
      const contents = await streamText(entry, maximum, normalized)
      if (normalized === 'package.json') manifestText = contents
      if (normalized === expectedPatch) patchText = contents
    }
    await completed
  } catch (error) {
    extractor.destroy(error instanceof Error ? error : new Error(String(error)))
    await completed.catch(() => undefined)
    throw error
  }
  return { paths, manifestText, patchText }
}

function safeArchivePath(value) {
  if (typeof value !== 'string' || value.includes('\0') || value.includes('\\')) return null
  const stripped = value.replace(/^\.\//, '').replace(/^package\//, '')
  if (stripped === '' || stripped.startsWith('/') || stripped.split('/').includes('..')) return null
  return stripped.replace(/^\.\//, '')
}

function normalizePackagePath(value) {
  return String(value).replace(/^\.\//, '').replace(/\\/g, '/')
}

async function boundedBytes(response, maximum, label) {
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > maximum) throw new InvalidCandidateError(label + ' exceeds ' + String(maximum) + ' bytes')
  if (response.body === null) throw new RetryCandidateError(label + ' returned no response body')
  const reader = response.body.getReader()
  const chunks = []
  let length = 0
  for (;;) {
    const part = await reader.read()
    if (part.done) break
    length += part.value.byteLength
    if (length > maximum) {
      await reader.cancel()
      throw new InvalidCandidateError(label + ' exceeds ' + String(maximum) + ' bytes')
    }
    chunks.push(part.value)
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)), length)
}

async function streamText(stream, maximum, label) {
  const chunks = []
  let length = 0
  for await (const chunk of stream) {
    length += chunk.length
    if (length > maximum) throw new InvalidCandidateError(label + ' exceeds ' + String(maximum) + ' bytes')
    chunks.push(chunk)
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length))
  } catch {
    throw new InvalidCandidateError(label + ' is not valid UTF-8')
  }
}

function rejected(spec, reason, detail = undefined) {
  return { verified: false, spec, reason, ...(detail === undefined ? {} : { detail }) }
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
