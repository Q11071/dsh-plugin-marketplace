/** 已构建 Host 的快速接单、重复抑制与卸载失败隔离测试。 */

import { strict as assert } from 'node:assert'
import MarketplaceService from '../lib/index.js'
import { JobTable, MutationQueue } from '../src/host/installer.ts'

type TestService = {
  restartPending: boolean
  pendingInstallResolution: number
  jobs: JobTable
  mutationQueue: MutationQueue
  registry: { find: (repo: string) => Promise<typeof plugin> }
  github: { details: () => Promise<never> }
  startJob: (kind: 'install' | 'update', repo: string, ref: string) => Promise<{ ok: boolean; value?: { jobId: string }; error?: { code: string } }>
  uninstallBatch: (request: { packageNames: string[] }) => Promise<{ ok: boolean; value?: { jobs: Array<{ jobId: string }> } }>
}

const plugin = {
  fullName: 'owner/plugin',
  packageName: 'fixture-plugin',
  version: '1.0.0',
  bundlePatch: './cordis.patch.yml',
  verifiedCommit: 'a'.repeat(40),
  install: {
    mode: 'automatic' as const,
    source: 'github' as const,
    spec: 'github:owner/plugin#' + 'a'.repeat(40),
    profiles: ['web'],
    requiresRestart: true,
  },
}

let rejectDetails: ((error: Error) => void) | undefined
const details = new Promise<never>((_resolve, reject) => { rejectDetails = reject })
const service = Object.create(MarketplaceService.prototype) as TestService
service.restartPending = false
service.pendingInstallResolution = 0
service.jobs = new JobTable()
service.mutationQueue = new MutationQueue()
service.registry = { find: async () => plugin }
service.github = { details: async () => details }

const started = await service.startJob('update', plugin.fullName, plugin.verifiedCommit)
assert.equal(started.ok, true)
assert.ok(started.value?.jobId, 'update must return a job id before GitHub details settle')
assert.equal(service.jobs.get(started.value!.jobId)?.finishedAt, null)

const duplicate = await service.startJob('update', plugin.fullName, plugin.verifiedCommit)
assert.equal(duplicate.ok, false)
assert.equal(duplicate.error?.code, 'job-duplicate')

rejectDetails?.(new Error('synthetic GitHub failure'))
await service.mutationQueue.drain()
assert.equal(service.jobs.get(started.value!.jobId)?.phase, 'failed')

const removals = await service.uninstallBatch({ packageNames: ['plugin-a', 'plugin-b'] })
assert.equal(removals.ok, true)
assert.equal(removals.value?.jobs.length, 2)
await service.mutationQueue.drain()
for (const job of removals.value?.jobs ?? []) assert.equal(service.jobs.get(job.jobId)?.phase, 'failed')

console.log('operation queue tests passed: 3')
