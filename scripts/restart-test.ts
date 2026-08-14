/** Safe smoke test for the detached restart helper; never signals this process. */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchRestartHelper } from '../src/host/restart.ts'

const dir = mkdtempSync(path.join(tmpdir(), 'dsh-marketplace-restart-'))
const marker = path.join(dir, 'restarted.txt')
const parent = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 500)'], {
  stdio: 'ignore',
  windowsHide: true,
})

try {
  await new Promise<void>((resolve, reject) => {
    parent.once('spawn', resolve)
    parent.once('error', reject)
  })
  assert(parent.pid !== undefined)
  await launchRestartHelper({
    parentPid: parent.pid,
    executable: process.execPath,
    args: ['-e', "require('node:fs').writeFileSync(process.env.DSH_RESTART_TEST_MARKER, 'restarted')"],
    cwd: dir,
    env: { ...process.env, DSH_RESTART_TEST_MARKER: marker },
  })

  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(existsSync(marker), false, 'replacement must wait for the parent process to exit')

  const deadline = Date.now() + 8_000
  while (!existsSync(marker) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.equal(readFileSync(marker, 'utf8'), 'restarted')
  console.log('Controlled restart helper test passed')
} finally {
  if (parent.exitCode === null) parent.kill()
  rmSync(dir, { recursive: true, force: true })
}
