import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'
import { test } from 'node:test'
import { offlinePlugin } from './offline-plugin.ts'

const SCOPE = 'https://example.test/planner/'
const MAX_CONCURRENT_DOWNLOADS = 32
const turn = () => new Promise(resolve => setImmediate(resolve))
function deferred() {
  let resolve
  const promise = new Promise(ready => { resolve = ready })
  return { promise, resolve }
}

function workerFixture() {
  const handlers = new Map()
  const stores = new Map()
  const downloads = []
  const counters = { active: 0, maximum: 0, matches: 0 }
  let intercept = async () => {}
  const caches = {
    async open(name) {
      if (stores.has(name)) return stores.get(name)
      const responses = new Map()
      const cache = {
        responses,
        async match(input) { counters.matches += 1; return responses.get(typeof input === 'string' ? input : input.url)?.clone() },
        async keys() { return [...responses.keys()].map(url => new Request(url)) },
        async put(input, response) { responses.set(typeof input === 'string' ? input : input.url, response) },
        async addAll(requests) {
          downloads.push(requests.map(request => request.url))
          counters.active += requests.length
          counters.maximum = Math.max(counters.maximum, counters.active)
          try {
            await intercept(requests)
            for (const request of requests) {
              assert.equal(request.cache, 'reload')
              await cache.put(request, new Response(request.url))
            }
          } finally { counters.active -= requests.length }
        },
      }
      stores.set(name, cache)
      return cache
    },
    async has(name) { return stores.has(name) },
    async keys() { return [...stores.keys()] },
    async delete(name) { return stores.delete(name) },
  }
  const plugin = offlinePlugin()
  plugin.configResolved({ publicDir: fileURLToPath(new URL('../public/', import.meta.url)) })
  let source
  const bundle = Object.fromEntries(Array.from({ length: 96 }, (_, index) => [
    `assets/${String(index).padStart(3, '0')}.png`, { type: 'asset', source: 'synthetic' },
  ]))
  plugin.generateBundle.handler.call({ emitFile: asset => { source = asset.source } }, {}, bundle)
  const context = createContext({ caches, URL, Request, Response, Error, crypto: { randomUUID }, self: {
    registration: { scope: SCOPE },
    addEventListener: (type, handler) => handlers.set(type, handler),
  } })
  runInContext(source, context)
  const message = async type => {
    let result
    let completion
    handlers.get('message')({ data: { type }, ports: [{ postMessage: value => { result = value } }], waitUntil: promise => { completion = promise } })
    await completion
    return result
  }
  return {
    stores, downloads, counters, message,
    intercept: callback => { intercept = callback },
    install: () => {
      let completion
      handlers.get('install')({ waitUntil: promise => { completion = promise } })
      return completion
    },
  }
}

test('offline installation makes progress past a slow batch within its download limit', async () => {
  const fixture = workerFixture()
  const slow = deferred()
  fixture.intercept(requests => requests.some(request => request.url.endsWith('/000.png')) ? slow.promise : Promise.resolve())
  let installed = false
  const installation = fixture.install().then(() => { installed = true })
  try {
    await turn()
    assert.ok(fixture.downloads.flat().some(url => url.endsWith('/095.png')), 'Other batches must continue while the first file is slow')
    assert.equal(installed, false, 'Installation must wait for every file')
    assert.ok(fixture.counters.maximum <= MAX_CONCURRENT_DOWNLOADS)
    assert.equal(fixture.counters.maximum, MAX_CONCURRENT_DOWNLOADS)
  } finally { slow.resolve(); await installation }
  assert.equal((await fixture.message('CHECK_READINESS')).ready, true)
  assert.ok(fixture.counters.matches < 5, 'Readiness must inspect cache keys without opening every response')
})

test('failed refresh drains writes before rollback and preserves the active cache for retry', async () => {
  const fixture = workerFixture()
  await fixture.install()
  const original = [...fixture.stores.values()][0]
  const before = [...original.responses.keys()]
  const pending = deferred()
  let batches = 0
  fixture.intercept(() => {
    batches += 1
    if (batches === 1) throw new Error('Synthetic download failure')
    return batches === 2 ? pending.promise : Promise.resolve()
  })
  let finished = false
  const refresh = fixture.message('REFRESH_CACHE').then(result => { finished = true; return result })
  try {
    await turn()
    assert.equal(finished, false, 'Rollback must wait for in-flight cache writes')
    assert.ok([...fixture.stores.keys()].some(name => name.startsWith('crykit-refresh-')))
    assert.ok(batches <= 4, 'A failed batch must stop scheduling new downloads')
  } finally { pending.resolve() }
  const failure = await refresh
  assert.equal(failure.ready, false)
  assert.equal(failure.error, 'Synthetic download failure')
  assert.deepEqual([...original.responses.keys()], before)
  assert.equal([...fixture.stores.keys()].some(name => name.startsWith('crykit-refresh-')), false)
  assert.equal((await fixture.message('CHECK_READINESS')).ready, true)
  fixture.intercept(async () => {})
  assert.equal((await fixture.message('REFRESH_CACHE')).ready, true)
  assert.equal([...fixture.stores.keys()].filter(name => name.startsWith('crykit-refresh-')).length, 1)
})

test('readiness remains false until preparation repairs every missing file', async () => {
  const fixture = workerFixture()
  await fixture.install()
  const cache = [...fixture.stores.values()][0]
  const missing = `${SCOPE}assets/050.png`
  cache.responses.delete(missing)
  cache.responses.set(`${SCOPE}unrelated.png`, new Response('Unrelated cache entry'))
  assert.equal((await fixture.message('CHECK_READINESS')).ready, false)
  fixture.downloads.length = 0
  assert.equal((await fixture.message('PREPARE_CACHE')).ready, true)
  assert.deepEqual(fixture.downloads.flat(), [missing])
})
