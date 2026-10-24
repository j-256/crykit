import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext, Script } from 'node:vm'
import { test } from 'node:test'
import { offlinePlugin } from './offline-plugin.ts'
import { ocrAssets } from './ocr-assets.ts'

const SCOPE = 'https://example.test/planner/'
const MAX_CONCURRENT_DOWNLOADS = 32
const turn = () => new Promise(resolve => setImmediate(resolve))
function deferred() {
  let resolve
  const promise = new Promise(ready => { resolve = ready })
  return { promise, resolve }
}

const OPTIONAL_ASSETS = {
  'assets/geometry-0.bin': { type: 'asset', source: 'terrain', originalFileNames: ['src/assets/world-map/geometry-0.bin'] },
  'assets/portrait.png': { type: 'asset', source: 'portrait', originalFileNames: ['src/assets/game-assets/portrait.png'] },
  'ocr/worker.min.js': { type: 'asset', source: 'recognition' },
}

function workerFixture(scope = SCOPE, options = {}) {
  const handlers = new Map()
  const stores = options.stores ?? new Map()
  const downloads = []
  const progress = []
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
  const plugin = offlinePlugin(options.plugin)
  plugin.configResolved({ publicDir: fileURLToPath(new URL('../public/', import.meta.url)), base: new URL(scope).pathname })
  let source
  const emitted = new Map()
  const bundle = Object.fromEntries(Array.from({ length: 96 }, (_, index) => [
    `assets/${String(index).padStart(3, '0')}.png`, { type: 'asset', source: 'synthetic' },
  ]))
  Object.assign(bundle, { [options.plugin?.indexSource ?? 'index.html']: { type: 'asset', source: 'Synthetic app shell' } }, OPTIONAL_ASSETS, options.bundle)
  plugin.generateBundle.handler.call({ emitFile: asset => { emitted.set(asset.fileName, asset.source); if (asset.fileName === 'sw.js') source = asset.source } }, {}, bundle)
  const context = createContext({ caches, URL, Request, Response, Error, crypto: { randomUUID }, self: {
    registration: { scope }, location: { origin: new URL(scope).origin },
    clients: { matchAll: async () => [{ url: SCOPE, postMessage: value => progress.push(value) }] },
    addEventListener: (type, handler) => handlers.set(type, handler),
  } })
  runInContext(source, context)
  const message = async (type, data = {}) => {
    let result
    let completion
    handlers.get('message')({ data: { type, contentVersion: 1, ...data }, ports: [{ postMessage: value => { if ('ready' in value) result = value } }], waitUntil: promise => { completion = promise } })
    await completion
    return result
  }
  return {
    stores, downloads, counters, message, progress, bundle, emitted,
    fetch: request => { let intercepted = false; handlers.get('fetch')({ request, respondWith: () => { intercepted = true } }); return intercepted },
    response: request => { let result; handlers.get('fetch')({ request, respondWith: response => { result = response } }); return result },
    intercept: callback => { intercept = callback },
    install: () => {
      let completion
      handlers.get('install')({ waitUntil: promise => { completion = promise } })
      return completion
    },
  }
}

test('entry recovery loads before the module graph and remains in the versioned offline core', async () => {
  const fixture = workerFixture(SCOPE, { bundle: { 'index.html': { type: 'asset', source: '<head><script type="module" src="/assets/app.js"></script></head><body><div id="root"></div></body>' } } })
  const recovery = [...fixture.emitted.keys()].find(name => /^assets\/startup-recovery-[a-f0-9]+\.js$/.test(name))
  assert.ok(recovery)
  assert.doesNotThrow(() => new Script(fixture.emitted.get(recovery)), 'Recovery must remain directly executable as a classic script')
  const html = fixture.bundle['index.html'].source
  const tag = `<script src="${new URL(SCOPE).pathname}${recovery}"></script>`
  assert.ok(html.includes(tag))
  assert.ok(html.indexOf('<div id="root">') < html.indexOf(tag))
  assert.ok(html.indexOf(tag) < html.indexOf('<script type="module"'))
  await fixture.install()
  assert.ok(fixture.downloads.flat().includes(new URL(recovery, SCOPE).href))
  assert.equal((await fixture.message('CHECK_READINESS')).ready, true)
})

test('entry relocation preserves HTML tokens and inert script-like text', () => {
  const inert = '<scr<script type="module" src="/assets/inert.js"></script>ipt>'
  const comment = '<!-- <script type="module" src="/assets/comment.js"></script> -->'
  const text = '<textarea><script type="module" src="/assets/text.js"></script></textarea>'
  const module = '<script type="module" data-note=">" src="/assets/app.js"></script>'
  const fixture = workerFixture(SCOPE, { bundle: { 'index.html': { type: 'asset', source: `<html><head>${module}</head><body><div id="root"></div>${inert}${comment}${text}</body></html>` } } })
  const html = fixture.bundle['index.html'].source
  for (const unchanged of [inert, comment, text]) assert.ok(html.includes(unchanged), 'Relocating an entry must not reinterpret other HTML')
  assert.ok(html.indexOf('<div id="root">') < html.indexOf(module))
  assert.equal(html.split(module).length, 2, 'The complete module element must occur exactly once')
})

test('entry relocation does not join surrounding text into an HTML element', () => {
  const source = '<html><body><div id="root"></div><<script type="module" src="/assets/app.js"></script>script>inert</body></html>'
  const fixture = workerFixture(SCOPE, { bundle: { 'index.html': { type: 'asset', source } } })
  assert.ok(!fixture.bundle['index.html'].source.includes('<script>inert'))
})

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

test('core installation excludes optional terrain, artwork and OCR while reporting real progress', async () => {
  const fixture = workerFixture()
  await fixture.install()
  const downloaded = fixture.downloads.flat()
  for (const name of Object.keys(OPTIONAL_ASSETS)) assert.ok(!downloaded.includes(new URL(name, SCOPE).href), `${name} must be opt-in`)
  const status = await fixture.message('CHECK_READINESS')
  assert.equal(status.ready, true)
  assert.equal(status.contents.find(content => content.id === 'core').ready, true)
  for (const id of ['maps', 'artwork', 'screenshots']) assert.equal(status.contents.find(content => content.id === id).ready, false)
  const completed = fixture.progress.filter(event => event.type === 'OFFLINE_PROGRESS').at(-1).progress
  assert.equal(completed.completedFiles, downloaded.length)
  assert.equal(completed.completedFiles, completed.totalFiles)
  assert.equal(completed.completedBytes, completed.totalBytes)
  assert.ok(completed.totalBytes > 0)
})

test('selected extras download exactly their missing assets and retain earlier downloads when unchecked', async () => {
  const fixture = workerFixture()
  await fixture.install()
  fixture.downloads.length = 0
  const prepared = await fixture.message('PREPARE_CACHE', { extras: ['maps'] })
  assert.equal(prepared.ready, true)
  assert.deepEqual(fixture.downloads.flat(), [new URL('assets/geometry-0.bin', SCOPE).href])
  assert.equal(prepared.contents.find(content => content.id === 'maps').ready, true)
  assert.equal(prepared.contents.find(content => content.id === 'artwork').ready, false)
  fixture.downloads.length = 0
  const unchecked = await fixture.message('PREPARE_CACHE', { extras: [] })
  assert.equal(unchecked.ready, true)
  assert.equal(unchecked.contents.find(content => content.id === 'maps').ready, true)
  assert.equal(unchecked.contents.find(content => content.id === 'maps').selected, false)
  assert.deepEqual(fixture.downloads, [])
})

test('an extra download failure leaves prepared core files and their readiness intact for retry', async () => {
  const fixture = workerFixture()
  await fixture.install()
  fixture.intercept(() => { throw new Error('Synthetic optional download failure') })
  const failed = await fixture.message('PREPARE_CACHE', { extras: ['screenshots'] })
  assert.equal(failed.error, 'Synthetic optional download failure')
  const retained = await fixture.message('CHECK_READINESS')
  assert.equal(retained.ready, true)
  assert.equal(retained.contents.find(content => content.id === 'screenshots').ready, false)
  fixture.intercept(async () => {})
  const retried = await fixture.message('PREPARE_CACHE', { extras: ['screenshots'] })
  assert.equal(retried.ready, true)
  assert.equal(retried.contents.find(content => content.id === 'screenshots').ready, true)
})

test('refresh and a build update preserve the selected extras without adding other downloads', async () => {
  const fixture = workerFixture()
  await fixture.install()
  await fixture.message('PREPARE_CACHE', { extras: ['artwork'] })
  fixture.downloads.length = 0
  const refreshed = await fixture.message('REFRESH_CACHE')
  assert.equal(refreshed.contents.find(content => content.id === 'artwork').ready, true)
  assert.ok(!fixture.downloads.flat().some(url => url.endsWith('/geometry-0.bin') || url.includes('/ocr/')))
  const update = workerFixture(SCOPE, { stores: fixture.stores, bundle: { 'assets/new-build.js': { type: 'asset', source: 'Updated core' } } })
  await update.install()
  const updated = await update.message('CHECK_READINESS')
  assert.equal(updated.contents.find(content => content.id === 'artwork').ready, true)
  assert.equal(updated.contents.find(content => content.id === 'artwork').selected, true)
  assert.equal(updated.contents.find(content => content.id === 'maps').selected, false)
})

test('synthetic account entry uses the same core policy with its own renamed shell and scope', async () => {
  const fixture = workerFixture(SCOPE, { plugin: { publicAssets: [], indexSource: 'crypto-proof.html' } })
  await fixture.install()
  assert.ok(fixture.downloads.flat().includes(new URL('index.html', SCOPE).href))
  assert.ok(!fixture.downloads.flat().includes(new URL('crypto-proof.html', SCOPE).href))
  assert.ok(!fixture.downloads.flat().some(url => url.endsWith('/icon.svg') || url.includes('/ocr/')))
  assert.equal((await fixture.message('CHECK_READINESS')).ready, true)
})

test('an independently cached HTML entry keeps its own page instead of falling back to the planner', async () => {
  const fixture = workerFixture(SCOPE, { bundle: { 'account-workspace.html': { type: 'asset', source: 'Independent entry' } } })
  await fixture.install()
  const workspaceUrl = new URL('account-workspace.html', SCOPE).href
  for (const fragment of ['', '#/settings/account']) {
    const workspace = await fixture.response({ method: 'GET', mode: 'navigate', url: workspaceUrl + fragment })
    assert.equal(await workspace.text(), workspaceUrl)
  }
  const nested = await fixture.response({ method: 'GET', mode: 'navigate', url: new URL('some/deep/route', SCOPE).href })
  assert.equal(await nested.text(), new URL('index.html', SCOPE).href)
})

test('an asset shared with an essential source stays essential even if artwork also references it', async () => {
  const fixture = workerFixture(SCOPE, { bundle: { 'assets/shared.png': { type: 'asset', source: 'Shared essential illustration', originalFileNames: ['src/assets/game-assets/shared.png', 'src/assets/essential-controls/shared.png'] } } })
  await fixture.install()
  assert.ok(fixture.downloads.flat().includes(new URL('assets/shared.png', SCOPE).href))
})

test('old clients retain all-assets readiness and legacy installed extras survive an upgrade', async () => {
  const fixture = workerFixture()
  await fixture.install()
  assert.equal((await fixture.message('CHECK_READINESS', { contentVersion: undefined })).ready, false)
  assert.equal((await fixture.message('PREPARE_CACHE', { contentVersion: undefined })).ready, true)
  const original = [...fixture.stores.values()][0]
  original.responses.delete(new URL('__crykit_offline_selection__', SCOPE).href)
  const update = workerFixture(SCOPE, { stores: fixture.stores, bundle: { 'assets/new-build.js': { type: 'asset', source: 'Updated legacy installation' } } })
  await update.install()
  const status = await update.message('CHECK_READINESS')
  assert.equal(status.ready, true)
  assert.ok(status.contents.every(content => content.ready && content.selected))
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
  const published = fixture.progress.filter(message => message.type === 'OFFLINE_STATUS').at(-1)
  assert.equal(published.ready, true, 'A failed refresh must still publish the retained cache availability')
  assert.equal(published.error, undefined, 'A delayed status broadcast must not overwrite a successful readiness inspection with the action error')
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


test('buildNeverPublishesPrivateFixturesOrUnsafeCacheRoutes: API and admin bypass caches', () => {
  const fixture = workerFixture('https://example.test/')
  for (const path of ['/api/public/v1/shares/id', '/api/v1/account', '/api/v1/shares', '/api', '/admin', '/admin/users']) {
    assert.equal(fixture.fetch({ method: 'GET', mode: 'navigate', url: new URL(path, SCOPE).href }), false)
  }
  assert.equal(fixture.counters.matches, 0)
})

test('offline OCR retains self-contained browser cores without duplicating their WASM payloads', () => {
  const emitted = new Map()
  ocrAssets().generateBundle.call({ emitFile: asset => emitted.set(asset.fileName, asset.source) })
  assert.equal([...emitted.keys()].some(name => name.endsWith('.wasm')), false, 'Standalone binaries duplicate the inline cores')
  const require = createRequire(import.meta.url)
  const coreDirectory = dirname(require.resolve('tesseract.js-core/package.json'))
  for (const variant of ['lstm', 'simd-lstm', 'relaxedsimd-lstm']) {
    const stem = `tesseract-core-${variant}`
    const wasm = readFileSync(join(coreDirectory, `${stem}.wasm`))
    const wrapper = emitted.get(`ocr/${stem}.wasm.js`)
    assert.ok(wrapper, `Browser fallback ${variant} must remain available`)
    assert.ok(wrapper.toString().includes(wasm.toString('base64')), 'Removing a standalone binary requires its exact inline payload')
  }
  assert.ok(emitted.has('ocr/worker.min.js'))
  assert.ok(emitted.has('ocr/eng.traineddata.gz'))
})
