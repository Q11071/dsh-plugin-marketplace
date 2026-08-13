/** Install/uninstall/update job table and the pnpm spawn pipeline.
 *  Jobs run detached from the RPC call: installPlugin() returns a jobId and the
 *  client polls jobStatus(), so a long pnpm run never blocks the wire.
 */

import { spawn } from 'node:child_process'
import type {
  MarketplaceJobKind,
  MarketplaceJobPhase,
  MarketplaceJobStatus,
} from '../types.ts'

const MAX_LOG_CHARS = 65536
const MAX_JOBS = 8

export interface JobOutcome {
  packageName: string
  version: string
  requiresRestart: boolean
}

export interface JobFailure {
  code: string
  message: string
}

export interface JobRecord {
  jobId: string
  kind: MarketplaceJobKind
  packageName: string
  phase: MarketplaceJobPhase
  log: string
  exitCode: number | null
  startedAt: number
  finishedAt: number | null
  outcome: JobOutcome | null
  failure: JobFailure | null
}

export class JobTable {
  private readonly jobs = new Map<string, JobRecord>()
  private seq = 0

  create(kind: MarketplaceJobKind, packageName: string): JobRecord {
    this.seq += 1
    const record: JobRecord = {
      jobId: 'mkt-' + String(this.seq) + '-' + Date.now().toString(36),
      kind,
      packageName,
      phase: 'spawning',
      log: '',
      exitCode: null,
      startedAt: Date.now(),
      finishedAt: null,
      outcome: null,
      failure: null,
    }
    this.jobs.set(record.jobId, record)
    while (this.jobs.size > MAX_JOBS) {
      const oldest = this.jobs.keys().next().value
      if (oldest === undefined) break
      this.jobs.delete(oldest)
    }
    return record
  }

  get(jobId: string): JobRecord | undefined {
    return this.jobs.get(jobId)
  }

  activeFor(packageName: string): boolean {
    for (const job of this.jobs.values()) {
      if (job.packageName === packageName && job.finishedAt === null) return true
    }
    return false
  }

  append(job: JobRecord, chunk: string): void {
    job.log = (job.log + chunk).slice(-MAX_LOG_CHARS)
  }

  phase(job: JobRecord, value: MarketplaceJobPhase): void {
    job.phase = value
  }

  exit(job: JobRecord, code: number | null): void {
    job.exitCode = code
  }

  settle(job: JobRecord, outcome: JobOutcome): void {
    job.phase = 'done'
    job.outcome = outcome
    job.finishedAt = Date.now()
  }

  fail(job: JobRecord, failure: JobFailure): void {
    job.phase = 'failed'
    job.failure = failure
    job.finishedAt = Date.now()
  }

  snapshot(job: JobRecord): MarketplaceJobStatus {
    return {
      jobId: job.jobId,
      kind: job.kind,
      packageName: job.packageName,
      phase: job.phase,
      log: job.log,
      exitCode: job.exitCode,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      outcome: job.outcome === null ? null : { ...job.outcome },
      failure: job.failure === null ? null : { ...job.failure },
    }
  }
}

/**
 * Run one pnpm invocation in the profile directory, streaming stdout and
 * stderr into the job log. Mirrors the CLI's Windows shell forwarding
 * (pnpm resolves through its .cmd shim).
 */
export function runPnpmJob(job: JobRecord, args: string[], dir: string, table: JobTable): Promise<number | null> {
  return new Promise((resolve) => {
    table.append(job, '$ pnpm ' + args.join(' ') + '\n')
    const child = spawn('pnpm', args, {
      cwd: dir,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    child.stdout?.on('data', (chunk: Buffer) => { table.append(job, chunk.toString()) })
    child.stderr?.on('data', (chunk: Buffer) => { table.append(job, chunk.toString()) })
    child.on('error', (error) => {
      table.append(job, 'spawn failed: ' + error.message + '\n')
      resolve(null)
    })
    child.on('close', (code) => {
      table.exit(job, code)
      resolve(code)
    })
  })
}
