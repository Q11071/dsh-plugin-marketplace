/** Install/uninstall/update job table and the pnpm spawn pipeline.
 *  Jobs run detached from the RPC call: installPlugin() returns a jobId and the
 *  client polls jobStatus(), so a long pnpm run never blocks the wire.
 */

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type {
  MarketplaceJobKind,
  MarketplaceJobPhase,
  MarketplaceJobStatus,
} from '../types.ts'

const MAX_LOG_CHARS = 65536
const MAX_JOBS = 64
const MAX_ACTIVE_JOBS = 50
const WINDOWS_ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/

function resolveStoreDir(dir: string, storeDir: string): string {
  return isAbsolute(storeDir) || WINDOWS_ABSOLUTE_PATH.test(storeDir)
    ? storeDir
    : resolve(dir, storeDir)
}

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

  create(
    kind: MarketplaceJobKind,
    packageName: string,
    phase: MarketplaceJobPhase = 'spawning',
  ): JobRecord {
    this.seq += 1
    const record: JobRecord = {
      jobId: 'mkt-' + String(this.seq) + '-' + Date.now().toString(36),
      kind,
      packageName,
      phase,
      log: '',
      exitCode: null,
      startedAt: Date.now(),
      finishedAt: null,
      outcome: null,
      failure: null,
    }
    this.jobs.set(record.jobId, record)
    while (this.jobs.size > MAX_JOBS) {
      const oldestFinished = [...this.jobs.entries()].find(([, job]) => job.finishedAt !== null)?.[0]
      if (oldestFinished === undefined) break
      this.jobs.delete(oldestFinished)
    }
    return record
  }

  get(jobId: string): JobRecord | undefined {
    return this.jobs.get(jobId)
  }

  list(): MarketplaceJobStatus[] {
    return [...this.jobs.values()]
      .sort((left, right) => left.startedAt - right.startedAt)
      .map(job => this.snapshot(job))
  }

  hasActive(): boolean {
    for (const job of this.jobs.values()) {
      if (job.finishedAt === null) return true
    }
    return false
  }

  atCapacity(): boolean {
    let active = 0
    for (const job of this.jobs.values()) {
      if (job.finishedAt !== null) continue
      active += 1
      if (active >= MAX_ACTIVE_JOBS) return true
    }
    return false
  }

  hasActivePackage(packageName: string): boolean {
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

/** Profile 写操作的先进先出串行队列；单项拒绝不会阻断后续任务。 */
export class MutationQueue {
  private tail: Promise<void> = Promise.resolve()

  enqueue(work: () => Promise<void>): void {
    const scheduled = this.tail.catch(() => undefined).then(work)
    this.tail = scheduled.catch(() => undefined)
    void scheduled
  }

  async drain(): Promise<void> {
    await this.tail
  }
}

/**
 * Reuse the pnpm store the working directory's node_modules is already bound
 * to (read from node_modules/.modules.yaml). Passing the same store to every
 * pnpm invocation prevents ERR_PNPM_UNEXPECTED_STORE when the Profile and the
 * staging/plugin directories would otherwise resolve different stores.
 */
export function linkedPnpmStore(dir: string): string | null {
  try {
    const metadata = readFileSync(join(dir, 'node_modules', '.modules.yaml'), 'utf8')
    try {
      const parsed = JSON.parse(metadata) as { storeDir?: unknown }
      if (typeof parsed?.storeDir === 'string' && parsed.storeDir.trim() !== '') {
        const storeDir = parsed.storeDir.trim()
        return resolveStoreDir(dir, storeDir)
      }
    } catch {
      // Fall through to the YAML scan below.
    }
    const match = /^\s*["']?storeDir["']?\s*:\s*["']?([^"'\r\n]+)["']?\s*,?\s*$/m.exec(metadata)
    const storeDir = match?.[1]?.trim()
    if (storeDir === undefined || storeDir === '') return null
    return resolveStoreDir(dir, storeDir)
  } catch {
    return null
  }
}

/**
 * Build the pnpm argument list for one job, forwarding the store the working
 * directory is bound to (or the caller-supplied Profile-linked fallback).
 * Exposed separately so the store-selection logic is unit-testable without
 * spawning a process.
 */
export function pnpmArgsFor(
  args: string[],
  dir: string,
  fallbackStoreDir: string | null,
): { args: string[]; storeDir: string | null } {
  const storeDir = linkedPnpmStore(dir) ?? fallbackStoreDir
  return { args: storeDir === null ? args : [...args, '--config.store-dir=' + storeDir], storeDir }
}

/**
 * Run one pnpm invocation in the working directory, streaming stdout and
 * stderr into the job log. When the directory is bound to a pnpm store (or
 * the caller supplies a Profile-linked store as fallback), the same store is
 * forwarded through --config.store-dir so staging, plugin and Profile jobs
 * never drift onto another store. Mirrors the CLI's Windows shell forwarding
 * (pnpm resolves through its .cmd shim).
 */
export function runPnpmJob(
  job: JobRecord,
  args: string[],
  dir: string,
  table: JobTable,
  fallbackStoreDir: string | null = null,
): Promise<number | null> {
  return new Promise((resolve) => {
    const { args: pnpmArgs, storeDir } = pnpmArgsFor(args, dir, fallbackStoreDir)
    table.append(job, '$ pnpm ' + pnpmArgs.map((arg) => /\s/.test(arg) ? JSON.stringify(arg) : arg).join(' ') + '\n')
    if (storeDir !== null) table.append(job, 'Using profile-linked pnpm store: ' + storeDir + '\n')
    const child = spawn('pnpm', pnpmArgs, {
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
