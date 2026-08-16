/** Integration test for discovery-sidecar joining, filtering, and trending sort. */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { RegistryClient } from '../src/host/registry.ts'

const root = path.resolve(import.meta.dirname, '..')
const registry = JSON.parse(readFileSync(path.join(root, 'registry', 'plugins.json'), 'utf8')) as {
  schemaVersion: 2
  generatedAt: string
  plugins: Array<{ fullName: string, verifiedCommit: string }>
}
assert(registry.plugins.length >= 3)
const plugins = registry.plugins.slice(0, 3)
const dir = mkdtempSync(path.join(tmpdir(), 'dsh-marketplace-discovery-'))

try {
  writeFileSync(path.join(dir, 'plugins.json'), JSON.stringify({ ...registry, plugins }), 'utf8')
  writeFileSync(path.join(dir, 'discovery.json'), JSON.stringify({
    schemaVersion: 1,
    generatedAt: registry.generatedAt,
    windowDays: 7,
    plugins: [
      { fullName: plugins[0]!.fullName, categories: ['security'], starGrowth7d: 1 },
      { fullName: plugins[1]!.fullName, categories: ['ui'], starGrowth7d: 10 },
      { fullName: plugins[2]!.fullName, categories: ['ui', 'developer-tools'], starGrowth7d: 5 },
    ],
  }), 'utf8')
  writeFileSync(path.join(dir, 'security-report.json'), JSON.stringify({
    schemaVersion: 1,
    results: [{
      repository: plugins[0]!.fullName,
      verifiedCommit: plugins[0]!.verifiedCommit,
      scannedAt: registry.generatedAt,
      status: 'passed',
    }],
  }), 'utf8')
  writeFileSync(path.join(dir, 'compatibility-report.json'), JSON.stringify({
    schemaVersion: 1,
    results: [{
      repository: plugins[0]!.fullName,
      verifiedCommit: plugins[0]!.verifiedCommit,
      checkedAt: registry.generatedAt,
      result: 'partial',
    }],
  }), 'utf8')
  const source = pathToFileURL(path.join(dir, 'plugins.json')).href
  const client = new RegistryClient(source, source, 60_000, 10_000)
  const trending = await client.search('', 1, 'trending', 'all')
  assert.deepEqual(trending.items.map(plugin => plugin.starGrowth7d), [10, 5, 1])
  const ui = await client.search('', 1, 'stars', 'ui')
  assert.equal(ui.totalCount, 2)
  assert(ui.items.every(plugin => plugin.categories.includes('ui')))
  const verified = trending.items.find(plugin => plugin.fullName === plugins[0]!.fullName)
  assert.equal(verified?.verification.security.status, 'passed')
  assert.equal(verified?.verification.compatibility.status, 'partial')
  rmSync(path.join(dir, 'discovery.json'))
  const fallback = new RegistryClient(source, source, 60_000, 10_000)
  const withoutSidecar = await fallback.search('', 1, 'trending', 'all')
  assert(withoutSidecar.items.every(plugin => plugin.categories[0] === 'other' && plugin.starGrowth7d === 0))
  console.log('Discovery client integration tests passed')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
