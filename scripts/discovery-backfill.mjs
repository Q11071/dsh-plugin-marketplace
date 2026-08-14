/** Rebuild the bundled discovery sidecar from the current Registry and state. */

import { readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyPluginCategories } from './discovery-core.mjs'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const registry = JSON.parse(await readFile(path.join(root, 'registry', 'plugins.json'), 'utf8'))
const state = JSON.parse(await readFile(path.join(root, 'registry', 'state.json'), 'utf8'))
const repositories = state?.repositories !== null && typeof state?.repositories === 'object'
  ? state.repositories
  : {}
const plugins = registry.plugins.map(plugin => {
  const row = repositories[plugin.fullName.toLocaleLowerCase()]
  const growth = typeof row?.starGrowth7d === 'number' && Number.isInteger(row.starGrowth7d) && row.starGrowth7d >= 0
    ? row.starGrowth7d
    : 0
  return {
    fullName: plugin.fullName,
    categories: classifyPluginCategories(plugin),
    starGrowth7d: growth,
  }
})
const document = { schemaVersion: 1, generatedAt: registry.generatedAt, windowDays: 7, plugins }
const target = path.join(root, 'registry', 'discovery.json')
const temporary = target + '.tmp'
await writeFile(temporary, JSON.stringify(document, null, 2) + '\n', 'utf8')
await rename(temporary, target)
console.log('generated discovery metadata for ' + String(plugins.length) + ' plugins')
