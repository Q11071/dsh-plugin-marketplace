/** Unit tests for the Profile-linked pnpm store selection and arg building.
 *  Run: node --experimental-strip-types scripts/store-test.ts
 *  Covers PR notes §14 items 1–2 (store parsing forms and propagation).
 */

import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JobTable, linkedPnpmStore, pnpmArgsFor } from '../src/host/installer.ts'

let passed = 0
function ok(name: string, fn: () => void): void {
  fn()
  passed += 1
  console.log('ok - ' + name)
}

const tmp = mkdtempSync(join(tmpdir(), 'mkt-store-test-'))
try {
  // JSON form with a space in the path.
  const jsonDir = join(tmp, 'json')
  mkdirSync(join(jsonDir, 'node_modules'), { recursive: true })
  writeFileSync(join(jsonDir, 'node_modules', '.modules.yaml'), JSON.stringify({ storeDir: 'D:/store json' }))
  ok('reads JSON storeDir with spaces', () => assert.equal(linkedPnpmStore(jsonDir), 'D:/store json'))

  // Plain YAML scalar form, Windows backslash path.
  const yamlDir = join(tmp, 'yaml')
  mkdirSync(join(yamlDir, 'node_modules'), { recursive: true })
  writeFileSync(join(yamlDir, 'node_modules', '.modules.yaml'), 'storeDir: C:\\pnpm store\\v9\n')
  ok('reads YAML storeDir with backslashes', () => assert.equal(linkedPnpmStore(yamlDir), 'C:\\pnpm store\\v9'))

  // Missing .modules.yaml.
  const bareDir = join(tmp, 'bare')
  mkdirSync(join(bareDir, 'node_modules'), { recursive: true })
  ok('missing .modules.yaml resolves to null', () => assert.equal(linkedPnpmStore(bareDir), null))

  // Missing node_modules entirely.
  const emptyDir = join(tmp, 'empty')
  mkdirSync(emptyDir, { recursive: true })
  ok('missing node_modules resolves to null', () => assert.equal(linkedPnpmStore(emptyDir), null))

  // Relative storeDir is resolved against the bound project before it is
  // forwarded to staging or external plugin directories with another cwd.
  const relDir = join(tmp, 'relative')
  mkdirSync(join(relDir, 'node_modules'), { recursive: true })
  writeFileSync(join(relDir, 'node_modules', '.modules.yaml'), 'storeDir: ../../shared-store\n')
  ok('relative storeDir resolved against the linked project', () => {
    assert.equal(linkedPnpmStore(relDir), join(relDir, '../../shared-store'))
  })

  // Empty JSON storeDir falls back to the YAML scan / null.
  const emptyStore = join(tmp, 'empty-store')
  mkdirSync(join(emptyStore, 'node_modules'), { recursive: true })
  writeFileSync(join(emptyStore, 'node_modules', '.modules.yaml'), '{\n  "storeDir": ""\n}\n')
  ok('empty storeDir string resolves to null', () => assert.equal(linkedPnpmStore(emptyStore), null))

  // pnpmArgsFor: no store -> args unchanged.
  const noStore = pnpmArgsFor(['remove', 'some-pkg'], bareDir, null)
  ok('no store leaves args untouched', () => {
    assert.deepEqual(noStore.args, ['remove', 'some-pkg'])
    assert.equal(noStore.storeDir, null)
  })

  // pnpmArgsFor: linked store appended for every job kind.
  for (const args of [
    ['add', 'github:owner/repo#deadbeef', '--ignore-scripts'],
    ['remove', 'some-pkg'],
    ['install', '--lockfile-only', '--ignore-scripts'],
  ]) {
    const withStore = pnpmArgsFor(args, jsonDir, null)
    ok('linked store appended for pnpm ' + args[0], () => {
      assert.deepEqual(withStore.args, [...args, '--config.store-dir=D:/store json'])
      assert.equal(withStore.storeDir, 'D:/store json')
    })
  }

  // pnpmArgsFor: fallback store used when the directory is not bound.
  const fallback = pnpmArgsFor(['add', 'x'], bareDir, 'C:/fallback-store')
  ok('fallback store used when directory is unbound', () => {
    assert.deepEqual(fallback.args, ['add', 'x', '--config.store-dir=C:/fallback-store'])
  })

  // pnpmArgsFor: linked store wins over the fallback.
  const linkedWins = pnpmArgsFor(['remove', 'x'], yamlDir, 'C:/fallback-store')
  ok('linked store wins over fallback', () => {
    assert.deepEqual(linkedWins.args, ['remove', 'x', '--config.store-dir=C:\\pnpm store\\v9'])
  })

  const jobs = new JobTable()
  const first = jobs.create('install', 'first-plugin')
  ok('Profile mutations are globally serialized across package names', () => {
    assert.throws(() => jobs.create('update', 'second-plugin'), /another Profile plugin operation/i)
  })
  jobs.settle(first, { packageName: 'first-plugin', version: '1.0.0', requiresRestart: true })
  ok('a new Profile mutation can start after the previous job settles', () => {
    assert.equal(jobs.create('update', 'second-plugin').packageName, 'second-plugin')
  })
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log('store tests passed: ' + passed)
