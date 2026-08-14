import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildGuidedAgentTask } from '../src/host/guided-agent.ts'
import { RegistryClient } from '../src/host/registry.ts'

const registryUrl = pathToFileURL(path.resolve('registry/plugins.json')).href
const registry = new RegistryClient(registryUrl, registryUrl, 60_000, 10_000)
const plugin = (await registry.search('', 1, 'stars', 'all')).items.find(item => item.install.mode === 'guided')
assert(plugin, 'Registry needs at least one guided fixture')

const evidence = await registry.guidedEvidence(plugin.fullName)
assert(evidence, 'every bundled guided plugin must have scanner evidence')
assert.equal(evidence.verifiedCommit, plugin.verifiedCommit)
assert.equal(evidence.packageName, plugin.packageName)

const task = buildGuidedAgentTask(plugin, plugin.install.profiles[0] ?? 'web', 'install', evidence)
assert.equal(task.verifiedCommit, plugin.verifiedCommit)
assert.match(task.prompt, new RegExp(plugin.verifiedCommit))
assert.match(task.prompt, /不可信数据/)
assert.match(task.prompt, /原生审批/)
assert.match(task.prompt, /启动方法/)
assert.doesNotMatch(task.prompt, /改用 main、latest[^\n]*可以/)

const update = buildGuidedAgentTask(plugin, plugin.install.profiles[0] ?? 'web', 'update', evidence)
assert.match(update.title, /^更新插件 /)
assert.match(update.prompt, /保留现有配置/)

console.log(`guided Agent task valid: ${plugin.fullName} @ ${plugin.verifiedCommit}`)
