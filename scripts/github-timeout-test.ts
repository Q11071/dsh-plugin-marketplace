import assert from 'node:assert/strict'
import { GitHubClient, GitHubError } from '../src/host/github.ts'

interface GitHubClientInternals {
  api(path: string, cacheKey?: string): Promise<{ status: number; body: unknown; headers: Headers }>
  textFile(owner: string, repo: string, ref: string, file: string): Promise<string | null>
}

function internals(client: GitHubClient): GitHubClientInternals {
  return client as unknown as GitHubClientInternals
}

function waitForAbort(signal: AbortSignal | null | undefined): Promise<Response> {
  assert(signal, 'GitHub fetch must receive an AbortSignal')
  return new Promise<Response>((_resolve, reject) => {
    const guard = setTimeout(() => { reject(new Error('timeout signal did not abort the request')) }, 1_000)
    if (signal.aborted) {
      clearTimeout(guard)
      reject(signal.reason)
      return
    }
    signal.addEventListener('abort', () => {
      clearTimeout(guard)
      reject(signal.reason)
    }, { once: true })
  })
}

const originalFetch = globalThis.fetch
try {
  let apiSignal: AbortSignal | null | undefined
  globalThis.fetch = async (_input, init) => {
    apiSignal = init?.signal
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }
  const api = await internals(new GitHubClient(1_000)).api('/rate_limit')
  assert.equal(api.status, 200)
  assert(apiSignal, 'API request must carry the configured timeout signal')
  assert.equal(apiSignal.aborted, false)

  globalThis.fetch = async (_input, init) => await waitForAbort(init?.signal)
  await assert.rejects(
    internals(new GitHubClient(10)).api('/slow'),
    (error: unknown) => error instanceof GitHubError && error.code === 'network',
    'an API timeout must surface as a network GitHubError',
  )

  const urls: string[] = []
  const expected = '{"name":"fixture"}'
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    urls.push(url)
    if (url.startsWith('https://raw.githubusercontent.com/')) return await waitForAbort(init?.signal)
    return new Response(JSON.stringify({
      type: 'file',
      encoding: 'base64',
      content: Buffer.from(expected).toString('base64'),
    }), { status: 200 })
  }
  const text = await internals(new GitHubClient(10)).textFile('owner', 'repo', 'a'.repeat(40), 'package.json')
  assert.equal(text, expected)
  assert.equal(urls.length, 2, 'a Raw timeout must continue through the Contents API fallback')
  assert.match(urls[0] ?? '', /^https:\/\/raw\.githubusercontent\.com\//)
  assert.match(urls[1] ?? '', /^https:\/\/api\.github\.com\/repos\/owner\/repo\/contents\/package\.json\?ref=/)
} finally {
  globalThis.fetch = originalFetch
}

console.log('GitHub request timeout and Raw fallback tests passed')
