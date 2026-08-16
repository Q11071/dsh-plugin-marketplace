/** Market-maintained runtime probe executed only in a no-network Docker container. */

import { spawn } from 'node:child_process'
import { access, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'

const target = JSON.parse(await readFile('/work/target.json', 'utf8'))
const inspection = JSON.parse(await readFile('/work/install-inspection.json', 'utf8'))
const checks = {
  hostLoad: check('inconclusive', 'host-start-not-attempted'),
  agentLoop: target.agentCategory === true
    ? check('unsupported', 'mock-agent-loop-not-yet-available-in-harness-v1')
    : check('skipped', 'plugin-is-not-classified-as-an-agent-extension'),
  clientLoad: await clientCheck(target, inspection),
  dispose: check('inconclusive', 'host-disposal-not-attempted'),
  update: await updateCheck(),
  networkIsolation: check('passed', 'runtime-container-network-is-none'),
}

const dshPackageDir = '/work/runtime/node_modules/@deepseek-ai/dsh'
try {
  const dshManifest = JSON.parse(await readFile(path.join(dshPackageDir, 'package.json'), 'utf8'))
  const dshBin = typeof dshManifest.bin === 'string' ? dshManifest.bin : dshManifest.bin?.dsh
  if (typeof dshBin !== 'string' || dshBin.length === 0) throw new Error('official DSH package does not declare its CLI entry')
  const executable = path.resolve(dshPackageDir, dshBin)
  await access(executable)
  const baseline = await observeHost(executable, target.profile, '/work/baseline-home')
  if (baseline.hostLoad.status !== 'passed') {
    checks.hostLoad = check('inconclusive', 'clean-dsh-baseline-did-not-start: ' + baseline.hostLoad.reason)
    checks.dispose = baseline.dispose
    await writeFile('/work/runtime-probe.json', JSON.stringify({ checks, log: baseline.log }, null, 2) + '\n', 'utf8')
    process.exit(0)
  }
  const outcome = await observeHost(executable, target.profile, '/work/dsh-home')
  checks.hostLoad = outcome.hostLoad
  checks.dispose = outcome.dispose
  await writeFile('/work/runtime-probe.json', JSON.stringify({ checks, log: outcome.log }, null, 2) + '\n', 'utf8')
} catch (error) {
  checks.hostLoad = check('failed', 'dsh-host-probe-failed-before-start: ' + reason(error))
  checks.dispose = check('skipped', 'host-never-started')
  await writeFile('/work/runtime-probe.json', JSON.stringify({ checks, log: reason(error) }, null, 2) + '\n', 'utf8')
}

async function clientCheck(target, inspection) {
  if (target.hasClient !== true) return check('skipped', 'plugin-has-no-client-bundle')
  const entry = inspection.manifest?.clientEntry
  if (typeof entry !== 'string') return check('failed', 'client-bundle-entry-is-missing')
  const file = path.join(inspection.pluginDir, ...entry.split('/'))
  try {
    await access(file)
    const result = await run(process.execPath, ['--check', file], 15_000)
    if (result.code !== 0) return check('failed', 'client-bundle-syntax-invalid: ' + bounded(result.output))
    const source = await readFile(file, 'utf8')
    if (source.length > 5 * 1024 * 1024) return check('unsupported', 'client-bundle-exceeds-five-mib-probe-limit')
    const modules = await platformModules(source)
    const definitions = []
    const window = { __ModuleLoader__: { load: definition => { definitions.push(definition) } } }
    const context = vm.createContext({
      window,
      globalThis: window,
      console,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    })
    new vm.Script(source, { filename: file }).runInContext(context, { timeout: 5_000 })
    if (definitions.length !== 1 || typeof definitions[0]?.factory !== 'function') {
      return check('failed', 'client-bundle-did-not-register-one-module-loader-factory')
    }
    const exported = definitions[0].factory(specifier => {
      if (!modules.has(specifier)) throw new Error('undeclared client platform module: ' + specifier)
      return modules.get(specifier)
    })
    if (exported === null || (typeof exported !== 'object' && typeof exported !== 'function')) {
      return check('failed', 'client-module-factory-returned-no-plugin-exports')
    }
    return check('inconclusive', 'client-module-factory-loaded-browser-react-mount-not-executed-by-harness-v1')
  } catch (error) {
    if (/Cannot find package|Cannot find module|ERR_MODULE_NOT_FOUND|browser|document|window/i.test(reason(error))) {
      return check('unsupported', 'client-platform-runtime-is-incomplete: ' + reason(error))
    }
    return check('failed', 'client-bundle-check-failed: ' + reason(error))
  }
}

async function platformModules(source) {
  const require = createRequire('/work/runtime/package.json')
  const specifiers = [...new Set([...source.matchAll(/require\(["']([^"']+)["']\)/g)].map(match => match[1]))]
  const modules = new Map()
  for (const specifier of specifiers) {
    const resolved = require.resolve(specifier)
    let value
    try {
      value = require(specifier)
    } catch (error) {
      if (error?.code !== 'ERR_REQUIRE_ESM') throw error
      value = await import(pathToFileURL(resolved).href)
    }
    modules.set(specifier, value)
  }
  return modules
}

async function updateCheck() {
  try {
    const value = JSON.parse(await readFile('/work/update-probe.json', 'utf8'))
    if (!['passed', 'failed', 'unsupported', 'inconclusive'].includes(value.status) || typeof value.reason !== 'string') {
      return check('inconclusive', 'update-probe-result-is-invalid')
    }
    return check(value.status, value.reason)
  } catch (error) {
    if (error?.code === 'ENOENT') return check('unsupported', 'exact-source-has-no-staged-previous-npm-version')
    return check('inconclusive', 'update-probe-result-could-not-be-read: ' + reason(error))
  }
}

async function observeHost(executable, profile, dshHome) {
  // DSH's bundled HMR service deliberately checks process.execArgv, so this
  // cannot be supplied through NODE_OPTIONS (Node also rejects it there).
  const child = spawn(process.execPath, ['--expose-internals', executable, '--profile', profile], {
    cwd: '/work/agent-workspace',
    env: {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: '/work/user-home',
      DSH_HOME: dshHome,
      CI: '1',
      NO_COLOR: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const append = chunk => { output = bounded(output + chunk.toString('utf8'), 4000) }
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
  const early = await Promise.race([exited, delay(12_000).then(() => null)])
  if (early !== null) {
    const detail = bounded(output)
    if (configurationLimited(detail)) {
      return {
        hostLoad: check('unsupported', 'host-requires-configuration-or-external-service: ' + detail),
        dispose: check('skipped', 'host-exited-before-disposal-probe'),
        log: detail,
      }
    }
    return {
      hostLoad: check('failed', 'dsh-host-exited-during-startup: ' + detail),
      dispose: check('skipped', 'host-exited-before-disposal-probe'),
      log: detail,
    }
  }
  child.kill('SIGTERM')
  const graceful = await Promise.race([exited, delay(5_000).then(() => null)])
  if (graceful === null) {
    child.kill('SIGKILL')
    await Promise.race([exited, delay(2_000)])
    return {
      hostLoad: check('passed', 'dsh-profile-remained-running-for-observation-window'),
      dispose: check('timeout', 'dsh-host-did-not-exit-within-five-seconds-of-sigterm'),
      log: bounded(output),
    }
  }
  return {
    hostLoad: check('passed', 'dsh-profile-remained-running-for-observation-window'),
    dispose: check('passed', 'dsh-host-exited-after-sigterm'),
    log: bounded(output),
  }
}

function configurationLimited(text) {
  return /(?:missing|required|configure|configuration|credential|api[ _-]?key|token|account|login|no provider)/iu.test(text)
}

function run(file, args, timeout) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output = bounded(output + chunk.toString('utf8')) })
    child.stderr.on('data', chunk => { output = bounded(output + chunk.toString('utf8')) })
    child.once('error', reject)
    child.once('exit', code => resolve({ code, output }))
    setTimeout(() => { child.kill('SIGKILL') }, timeout).unref()
  })
}

function check(status, value) {
  return { status, reason: bounded(value, 500) }
}

function bounded(value, limit = 4000) {
  return String(value).replace(/[\r\t]+/g, ' ').slice(-limit)
}

function reason(error) {
  return bounded(error instanceof Error ? error.message : String(error), 500)
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
