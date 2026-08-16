/** Build a bounded Actions matrix for exact-commit security verification. */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { planSecurityScan } from './security-core.mjs'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const limit = positiveInteger(argument('--limit') ?? process.env.SECURITY_SCAN_LIMIT ?? '100', 'limit')
const batchSize = positiveInteger(argument('--batch-size') ?? process.env.SECURITY_BATCH_SIZE ?? '5', 'batch size')
const output = path.resolve(root, argument('--output') ?? '.security-work/plan.json')
const registry = JSON.parse(await readFile(path.join(root, 'registry', 'plugins.json'), 'utf8'))
const report = JSON.parse(await readFile(path.join(root, 'registry', 'security-report.json'), 'utf8'))
const state = JSON.parse(await readFile(path.join(root, 'registry', 'state.json'), 'utf8'))
const plan = planSecurityScan(registry, report, limit, batchSize, state)

await mkdir(path.dirname(output), { recursive: true })
await writeFile(output, JSON.stringify({
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  registryGeneratedAt: registry.generatedAt,
  selected: plan.selected,
  remaining: plan.remaining,
}, null, 2) + '\n', 'utf8')

const matrix = { include: plan.batches.map(batch => ({ batch: batch.id, repositories: batch.repositories })) }
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT,
    'matrix=' + JSON.stringify(matrix) + '\n'
    + 'has_work=' + String(plan.selected.length > 0) + '\n'
    + 'selected=' + String(plan.selected.length) + '\n'
    + 'remaining=' + String(plan.remaining) + '\n',
    'utf8')
}
console.log(JSON.stringify({ selected: plan.selected.length, batches: plan.batches.length, remaining: plan.remaining }, null, 2))

function argument(name) {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

function positiveInteger(value, label) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(label + ' must be a positive integer')
  return parsed
}
