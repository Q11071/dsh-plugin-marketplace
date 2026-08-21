/** 已构建 Host 的快速接单、重复抑制与卸载失败隔离测试。 */

import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
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

const manualRoot = mkdtempSync(join(tmpdir(), 'mkt-manual-queue-'))
const previousDshHome = process.env.DSH_HOME
const manualProfile = join(manualRoot, 'profiles', 'web')
const manualCommit = 'b'.repeat(40)
const manualDetails = {
  repo: 'owner/manual-plugin',
  ref: manualCommit,
  resolvedRef: manualCommit,
  manifest: {
    name: 'manual-plugin',
    version: '1.0.0',
    description: 'fixture',
    license: 'MIT',
    bundlePatch: './cordis.patch.yml',
    hasClient: false,
    entry: null,
  },
  patch: '[]\n',
  entrySource: null,
  readmeUrl: 'https://github.com/owner/manual-plugin#readme',
  rate: { limit: 5000, remaining: 4999, reset: 0 },
}
type ManualTestService = {
  restartPending: boolean
  pendingInstallResolution: number
  jobs: JobTable
  mutationQueue: MutationQueue
  ctx: { baseUrl: URL }
  config: { registryCacheMinutes: number; registryRequestTimeoutMs: number }
  github: { details: () => Promise<typeof manualDetails> }
  driveInstall: (job: ReturnType<JobTable['create']>) => Promise<void>
  manualInstall: (request: { command: string }) => Promise<{ ok: boolean; value?: { jobId: string }; error?: { code: string } }>
}

try {
  process.env.DSH_HOME = manualRoot
  mkdirSync(manualProfile, { recursive: true })
  writeFileSync(join(manualProfile, 'package.json'), JSON.stringify({
    name: 'visual-test-profile',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  }, null, 2) + '\n')

  let resolveManual!: (value: typeof manualDetails) => void
  const pendingManual = new Promise<typeof manualDetails>((resolve) => { resolveManual = resolve })
  const manualService = Object.create(MarketplaceService.prototype) as ManualTestService
  manualService.restartPending = false
  manualService.pendingInstallResolution = 0
  manualService.jobs = new JobTable()
  manualService.mutationQueue = new MutationQueue()
  manualService.ctx = { baseUrl: pathToFileURL(manualProfile + '/') }
  manualService.config = { registryCacheMinutes: 15, registryRequestTimeoutMs: 10_000 }
  manualService.github = { details: async () => pendingManual }
  let driveCalls = 0
  manualService.driveInstall = async (job) => {
    driveCalls += 1
    manualService.jobs.settle(job, { packageName: job.packageName, version: '1.0.0', requiresRestart: true })
  }

  const command = 'dsh plugin --profile web add github:owner/manual-plugin#' + manualCommit
  const pendingManualResult = manualService.manualInstall({ command })
  const competing = manualService.jobs.create('update', 'other-plugin')
  resolveManual(manualDetails)
  const blockedManual = await pendingManualResult
  assert.equal(blockedManual.ok, false)
  assert.equal(blockedManual.error?.code, 'job-running')
  assert.equal(driveCalls, 0, 'manual install must not race an operation accepted while GitHub details resolve')
  manualService.jobs.fail(competing, { code: 'fixture', message: 'finished fixture operation' })

  manualService.github = { details: async () => manualDetails }
  const acceptedManual = await manualService.manualInstall({ command })
  assert.equal(acceptedManual.ok, true)
  await manualService.mutationQueue.drain()
  assert.equal(driveCalls, 1, 'manual install must execute through the shared mutation queue')
} finally {
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
  rmSync(manualRoot, { recursive: true, force: true })
}

console.log('operation queue tests passed: 5')
