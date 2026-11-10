import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parse } from 'parse5'
import { build, createServer } from 'vite'
import { rumPlugin } from './rum-plugin.ts'
import { offlinePlugin } from './offline-plugin.ts'

const BEACON = 'https://static.cloudflareinsights.com/beacon.min.js'
const TOKEN = '0123456789abcdef0123456789abcdef'

function scripts(html) {
  const found = []
  function visit(node) {
    if (node.tagName === 'script') found.push(Object.fromEntries(node.attrs.map(({ name, value }) => [name, value])))
    for (const child of node.childNodes ?? []) visit(child)
  }
  visit(parse(html))
  return found.filter(script => script.src === BEACON)
}

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'crykit-rum-build-'))
  const previous = process.env.CRYKIT_RUM_SITE_TOKEN
  try {
    const html = '<!doctype html><html><head><title>Synthetic fixture</title></head><body><main>Fixture</main><script type="module" src="/app.js"></script></body></html>'
    await writeFile(join(directory, 'index.html'), html)
    await writeFile(join(directory, 'admin.html'), html)
    await writeFile(join(directory, 'app.js'), 'document.querySelector("main").textContent = "Synthetic app"')
    const config = { root: directory, configFile: false, publicDir: false, logLevel: 'silent', plugins: [rumPlugin(), offlinePlugin({ publicAssets: [] })], build: { outDir: join(directory, 'output'), rollupOptions: { input: { app: join(directory, 'index.html'), admin: join(directory, 'admin.html') } } } }
    await run({ directory, config, compile: async token => {
      if (token === undefined) delete process.env.CRYKIT_RUM_SITE_TOKEN
      else process.env.CRYKIT_RUM_SITE_TOKEN = token
      await build(config)
      return { app: await readFile(join(directory, 'output/index.html'), 'utf8'), admin: await readFile(join(directory, 'output/admin.html'), 'utf8'), worker: await readFile(join(directory, 'output/sw.js'), 'utf8') }
    } })
  } finally {
    if (previous === undefined) delete process.env.CRYKIT_RUM_SITE_TOKEN
    else process.env.CRYKIT_RUM_SITE_TOKEN = previous
    await rm(directory, { recursive: true, force: true })
  }
}

test('missing and empty opt-in keep app and admin builds free of the beacon', async () => {
  await fixture(async ({ compile }) => {
    for (const token of [undefined, '']) {
      const output = await compile(token)
      assert.deepEqual(scripts(output.app), [])
      assert.deepEqual(scripts(output.admin), [])
    }
  })
})

test('valid public token emits ordinary module beacon with SPA enabled only on the app entry', async () => {
  await fixture(async ({ compile }) => {
    const output = await compile(TOKEN)
    const tags = scripts(output.app)
    assert.equal(tags.length, 1)
    assert.equal(tags[0].type, 'module')
    assert.deepEqual(JSON.parse(tags[0]['data-cf-beacon']), { token: TOKEN, spa: true })
    assert.deepEqual(scripts(output.admin), [])
    assert.ok(output.app.indexOf('startup-recovery-') < output.app.indexOf(BEACON), 'Offline startup recovery must remain before module execution')
  })
})

test('invalid nonempty opt-ins fail without exposing their value in diagnostics', async () => {
  await fixture(async ({ compile }) => {
    for (const token of [' ', 'synthetic-invalid-token', TOKEN.slice(1), `${TOKEN}0`, `${TOKEN.slice(0, -1)}g`, `${TOKEN}<script>`]) {
      await assert.rejects(compile(token), error => {
        assert.match(error.message, /CRYKIT_RUM_SITE_TOKEN.*32.*hex/i)
        if (token.trim()) assert.equal(error.message.includes(token), false)
        return true
      })
    }
  })
})

test('offline shell identity includes the final token-bearing HTML', async () => {
  await fixture(async ({ compile }) => {
    const disabled = await compile(undefined)
    const first = await compile(TOKEN)
    const second = await compile('abcdef0123456789abcdef0123456789')
    const cache = worker => worker.match(/const CACHE_NAME = ([^;]+);/)[1]
    assert.notEqual(cache(disabled.worker), cache(first.worker))
    assert.notEqual(cache(first.worker), cache(second.worker))
    assert.notEqual(first.app, second.app)
  })
})

test('development transforms never enable the build-only beacon', async () => {
  await fixture(async ({ config }) => {
    process.env.CRYKIT_RUM_SITE_TOKEN = TOKEN
    const server = await createServer({ ...config, plugins: [rumPlugin()], server: { middlewareMode: true } })
    try {
      const html = await server.transformIndexHtml('/index.html', '<html><head></head><body></body></html>')
      assert.deepEqual(scripts(html), [])
    } finally { await server.close() }
  })
})
