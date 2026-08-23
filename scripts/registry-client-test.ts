/** RegistryClient 并发读取回归测试。 */

import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { RegistryClient } from '../src/host/registry.ts'

const plugin = {
  owner: 'owner',
  repo: 'plugin',
  fullName: 'owner/plugin',
  description: 'fixture',
  stars: 1,
  forks: 0,
  openIssues: 0,
  language: 'TypeScript',
  license: 'MIT',
  updatedAt: '2026-08-21T00:00:00.000Z',
  defaultBranch: 'main',
  verifiedCommit: 'a'.repeat(40),
  htmlUrl: 'https://github.com/owner/plugin',
  topics: ['dsh-plugin'],
  packageName: 'fixture-plugin',
  version: '1.0.0',
  bundlePatch: './cordis.patch.yml',
  hasClient: true,
  verifiedAt: '2026-08-21T00:00:00.000Z',
  install: {
    mode: 'automatic',
    source: 'github',
    spec: 'github:owner/plugin#' + 'a'.repeat(40),
    profiles: ['web'],
    requiresBuildApproval: false,
    requiresRestart: true,
    manualSteps: false,
    instructionsUrl: 'https://github.com/owner/plugin#readme',
  },
}

let registryReads = 0
let discoveryReads = 0
const server = createServer((request, response) => {
  response.setHeader('content-type', 'application/json')
  if (request.url === '/plugins.json') {
    registryReads += 1
    response.end(JSON.stringify({ schemaVersion: 2, generatedAt: '2026-08-21T00:00:00.000Z', plugins: [plugin] }))
    return
  }
  if (request.url === '/discovery.json') {
    discoveryReads += 1
    response.end(JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-08-21T00:00:00.000Z',
      windowDays: 7,
      plugins: [{ fullName: plugin.fullName, categories: ['developer-tools'], starGrowth7d: 1 }],
    }))
    return
  }
  response.statusCode = 404
  response.end('{}')
})

server.listen(0, '127.0.0.1')
await once(server, 'listening')
try {
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('测试 HTTP 服务未取得端口')
  const source = `http://127.0.0.1:${String(address.port)}/plugins.json`
  const registry = new RegistryClient(source, source, 60_000, 5_000)
  const results = await Promise.all([
    registry.search('', 1, 'stars', 'all'),
    registry.find(plugin.fullName),
    registry.findByPackage(plugin.packageName),
    registry.findByPackage(plugin.packageName),
    registry.findByPackages([plugin.packageName, 'missing-plugin']),
  ])

  assert.equal(results[0].items.length, 1)
  assert.equal(results[1]?.packageName, plugin.packageName)
  assert.equal(results[2]?.fullName, plugin.fullName)
  assert.deepEqual([...results[4].keys()], [plugin.packageName])
  assert.equal(registryReads, 1, '并发调用必须共享同一次 Registry 请求')
  assert.equal(discoveryReads, 1, '并发调用必须共享同一次 discovery 请求')
  await registry.refresh()
  assert.equal(registryReads, 2, '显式检查更新必须绕过 TTL 重新读取 Registry')
  assert.equal(discoveryReads, 2, '显式检查更新必须同步刷新 discovery 数据')
  console.log('registry client tests passed: 3')
} finally {
  server.close()
  await once(server, 'close')
}
