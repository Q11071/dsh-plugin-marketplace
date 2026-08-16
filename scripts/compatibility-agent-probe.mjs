/** Run one market-owned Agent Loop contract probe against an already-installed Profile. */

import { readdir, readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const target = JSON.parse(await readFile('/work/target.json', 'utf8'))
const dshPackageDir = await realpath('/work/runtime/node_modules/@deepseek-ai/dsh')
const requireFromDsh = createRequire(path.join(dshPackageDir, 'package.json'))
const result = await probe().catch(error => ({
  status: 'failed',
  reason: 'market-mock-agent-loop-failed: ' + boundedReason(error),
}))
process.stdout.write(`\n__DSH_COMPAT_AGENT__${JSON.stringify(result)}\n`)

async function probe() {
  const [profileBoot, appBoot, llm, session, tools] = await Promise.all([
    loadProfileBoot(),
    importFromDsh('@deepseek-ai/dsh-app-boot'),
    importFromDsh('@deepseek-ai/dsh-llm'),
    importFromDsh('@deepseek-ai/dsh-session'),
    importFromDsh('@deepseek-ai/dsh-tools'),
  ])
  const { ctx } = await profileBoot.runProfile({
    environment: appBoot.loadLayeredEnv('dsh'),
    profile: target.profile,
    patchFiles: [],
    args: [],
  })
  let check
  try {
    if (ctx.get('agentLoop') === undefined || ctx.get('llm') === undefined || ctx.get('tools') === undefined) {
      return { status: 'unsupported', reason: 'profile-does-not-compose-agent-loop-llm-and-tools-services' }
    }
    const provider = 'market-compatibility-mock'
    const toolName = 'market_compatibility_echo'
    const callId = 'market-compatibility-call'
    const adapter = new MarketAdapter(llm.LlmAdapter, callId, toolName)
    ctx.llm.registerAdapter([provider], adapter)
    ctx.tools.register(tools.defineContentToolFixture({
      name: toolName,
      description: 'Market-owned deterministic compatibility probe; returns no host data.',
      parameters: {},
      async execute() {
        return [{ type: 'text', text: 'market compatibility tool result' }]
      },
    }))
    const id = session.SessionId(`market-compatibility-${target.verifiedCommit.slice(0, 12)}`)
    const agent = ctx.agentLoop.create(id, { provider, model: 'deterministic' }, { cwd: '/work/agent-workspace' })
    agent.followup(llm.createUserMessage({
      content: [{ type: 'text', text: 'Run the deterministic market compatibility probe.' }],
      source: { kind: 'user' },
    }))
    await withTimeout(agent.whenIdle(), 12_000, 'market mock agent did not become idle')

    const events = [...agent.session.events]
    const toolResult = events.find(event => event.type === 'tool/result'
      && event.data?.message?.source?.callId === callId)
    const finalText = events
      .filter(event => event.type === 'assistant/message')
      .flatMap(event => event.data?.message?.content ?? [])
      .some(block => block?.type === 'text' && block.text === 'market compatibility complete')
    if (adapter.requests !== 2 || toolResult === undefined || toolResult.data.message.content[0]?.isError !== false || !finalText) {
      check = {
        status: 'inconclusive',
        reason: `agent-loop-was-intentionally-altered-or-incomplete: requests=${adapter.requests}, toolResult=${String(toolResult !== undefined)}, finalText=${String(finalText)}`,
      }
    } else {
      check = {
        status: 'passed',
        reason: 'real-agent-loop-preserved-request-tool-result-call-id-and-final-message',
      }
    }
  } catch (error) {
    check = { status: 'failed', reason: 'market-mock-agent-loop-failed: ' + boundedReason(error) }
  } finally {
    try {
      await ctx.fiber.dispose()
    } catch (error) {
      check = { status: 'failed', reason: 'market-mock-agent-disposal-failed: ' + boundedReason(error) }
    }
  }
  return check
}

async function loadProfileBoot() {
  const lib = path.join(dshPackageDir, 'lib')
  const names = (await readdir(lib))
    .filter(name => /^profile-boot-[A-Za-z0-9_-]+\.js$/.test(name))
    .sort()
  for (const name of names) {
    const module = await import(pathToFileURL(path.join(lib, name)).href)
    if (typeof module.runProfile === 'function') return module
  }
  throw new Error('official DSH package exposes no runProfile implementation in its generated profile-boot chunks')
}

async function importFromDsh(specifier) {
  return import(pathToFileURL(requireFromDsh.resolve(specifier)).href)
}

function MarketAdapter(Base, callId, toolName) {
  return new class extends Base {
    requests = 0

    resolveModel(provider, model) {
      return Promise.resolve({ provider, id: model, name: model })
    }

    async * stream() {
      this.requests += 1
      if (this.requests === 1) {
        const argumentsJson = '{}'
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: callId, name: toolName, argumentsDelta: argumentsJson }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: toolName, arguments: argumentsJson } }
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      if (this.requests === 2) {
        const text = 'market compatibility complete'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      throw new Error('market mock adapter received an unexpected extra request')
    }
  }()
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ])
}

function boundedReason(error) {
  return String(error instanceof Error ? error.message : error).replace(/[\r\n\t]+/g, ' ').slice(-420)
}
