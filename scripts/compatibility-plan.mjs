/** Build a bounded Actions matrix for exact-commit compatibility verification. */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { planCompatibilityScan } from './compatibility-core.mjs'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const limit = positiveInteger(argument('--limit') ?? process.env.COMPATIBILITY_SCAN_LIMIT ?? '20', 'limit')
const batchSize = positiveInteger(argument('--batch-size') ?? process.env.COMPATIBILITY_BATCH_SIZE ?? '2', 'batch size')
const output = path.resolve(root, argument('--output') ?? '.compatibility-work/plan.json')
const registry = JSON.parse(await readFile(path.join(root, 'registry', 'plugins.json'), 'utf8'))
const security = JSON.parse(await readFile(path.join(root, 'registry', 'security-report.json'), 'utf8'))
const report = JSON.parse(await readFile(path.join(root, 'registry', 'compatibility-report.json'), 'utf8'))
const plan = planCompatibilityScan(registry, security, report, limit, batchSize)

await mkdir(path.dirname(output), { recursive: true })
await writeFile(output, JSON.stringify({
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  registryGeneratedAt: registry.generatedAt,
  selected: plan.selected,
  eligible: plan.eligible,
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
console.log(JSON.stringify({ selected: plan.selected.length, batches: plan.batches.length, eligible: plan.eligible, remaining: plan.remaining }, null, 2))

function argument(name) {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

function positiveInteger(value, label) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(label + ' must be a positive integer')
  return parsed
}
