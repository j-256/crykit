import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { hostedSharePlugin, HOSTED_SHARE_SHELL } from './hosted-share-plugin.ts'

test('derived public shell resolves root assets without changing portable index or admitting analytics', async () => {
  const source = '<!doctype html><head><script type="module" src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon="{}"></script><link rel="stylesheet" href="./assets/app.css"></head><body><script type="module" src="./assets/app.js"></script></body>'
  const bundle = { 'index.html': { type: 'asset', fileName: 'index.html', source } }
  hostedSharePlugin().generateBundle.handler.call({ emitFile(asset) { bundle[asset.fileName] = asset } }, {}, bundle)
  assert.equal(bundle['index.html'].source, source)
  const shell = bundle[HOSTED_SHARE_SHELL].source
  assert.ok(shell.includes('<base href="/">'))
  assert.ok(!shell.includes('data-cf-beacon'))
  assert.ok(!shell.includes('https://static.cloudflareinsights.com'))
  assert.ok(shell.includes("script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'"))
  assert.ok(shell.includes('src="./assets/app.js"'))
  assert.equal(new URL('./assets/app.js', new URL('/', 'https://example.test/t/Abc0123-_xy')).pathname, '/assets/app.js')
  assert.equal(new URL('./assets/app.js', 'https://example.test/nested/').pathname, '/nested/assets/app.js')
})

test('actual pinned static proxy serves only single-segment hosted paths and keeps API routes separate', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crykit-hosted-routing-'))
  let runtime
  try {
    await mkdir(join(directory, 'assets'))
    await writeFile(join(directory, 'index.html'), 'Portable ordinary index')
    await writeFile(join(directory, HOSTED_SHARE_SHELL), '<base href="/">Hosted shell')
    await writeFile(join(directory, 'hosted-share-recovery.js'), '/* Bounded recovery */')
    await writeFile(join(directory, '_redirects'), await readFile(new URL('../public/_redirects', import.meta.url)))
    await writeFile(join(directory, 'assets/app.js'), 'Root module')
    runtime = new Miniflare(convertV4MiniflareOptions({ compatibilityDate: '2026-09-28', modules: true, script: 'export default {fetch(r,e){return new URL(r.url).pathname.startsWith("/api/")?new Response("API",{status:401}):e.ASSETS.fetch(r)}}', assets: { directory, binding: 'ASSETS', run_worker_first: ['/api/*'], routerConfig: { has_user_worker: true } } }))
    for (const id of ['Abc0123-_xy', 'AAAAAAAAAAAAAAAAAAAAAA']) for (const prefix of ['b', 't', 's']) {
      const response = await runtime.dispatchFetch(`http://localhost/${prefix}/${id}?untrusted=unused`)
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('location'), null)
      assert.equal(await response.text(), '<base href="/">Hosted shell')
    }
    assert.equal(await (await runtime.dispatchFetch('http://localhost/')).text(), 'Portable ordinary index')
    assert.equal(await (await runtime.dispatchFetch('http://localhost/assets/app.js')).text(), 'Root module')
    for (const prefix of ['b', 't', 's']) assert.equal(await (await runtime.dispatchFetch(`http://localhost/${prefix}/assets/startup-recovery-0123456789abcdef.js`)).text(), '/* Bounded recovery */')
    for (const path of ['/b/assets/entry.js', '/assets/startup-recovery-0123456789abcdef.js', '/b/id/extra', '/other/id']) assert.equal((await runtime.dispatchFetch(`http://localhost${path}`)).status, 404)
    const api = await runtime.dispatchFetch('http://localhost/api/public/v1/shares/Abc0123-_xy')
    assert.equal(api.status, 401)
    assert.equal(await api.text(), 'API')
  } finally { await runtime?.dispose(); await rm(directory, { recursive: true, force: true }) }
})

test('stale-client bridge only offers explicit recovery and cannot touch caches, profile storage, or navigation', async () => {
  const source = await readFile(new URL('../public/hosted-share-recovery.js', import.meta.url), 'utf8')
  class Element {
    children = []; textContent = ''; attributes = {}; src = ''; style = {}
    append(...elements) { this.children.push(...elements) }
    replaceChildren(...elements) { this.children = elements }
    setAttribute(name, value) { this.attributes[name] = value }
  }
  for (const [pathname, scriptPath, active] of [
    ['/b/Abc0123-_xy', '/b/assets/startup-recovery-0123456789abcdef.js', true],
    ['/t/AAAAAAAAAAAAAAAAAAAAAA', '/t/assets/startup-recovery-0123456789abcdef.js', true],
    ['/b/invalid', '/b/assets/startup-recovery-0123456789abcdef.js', false],
    ['/b/Abc0123-_xy', '/hosted-share-recovery.js', false],
  ]) {
    const root = new Element(), head = new Element(), script = new Element()
    script.src = 'https://example.test' + scriptPath
    const context = { URL, HTMLScriptElement: Element, location: { pathname }, document: { currentScript: script, head, getElementById: id => id === 'root' ? root : undefined, createElement: () => new Element() } }
    for (const name of ['navigator', 'caches', 'indexedDB', 'localStorage', 'sessionStorage']) Object.defineProperty(context, name, { get() { throw new Error('Unexpected durable or update access') } })
    runInNewContext(source, context)
    assert.equal(root.children.length, active ? 1 : 0)
    if (active) {
      const content = root.children[0].children[0]
      assert.equal(content.children[0].textContent, 'Update CryKit to open this share')
      assert.equal(content.children[2].href, '/#/settings/storage')
      assert.equal(head.children[0].httpEquiv, 'Content-Security-Policy')
    }
  }
})
