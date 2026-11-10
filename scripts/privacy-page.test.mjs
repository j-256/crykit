import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { build, createServer } from 'vite'
import { marked } from 'marked'
import { parse } from 'parse5'
import { privacyPagePlugin } from './privacy-page.ts'
import { offlinePlugin } from './offline-plugin.ts'

const SOURCE = '# Privacy & account terms\n\nYour **private records** stay yours.\n\n## Retention\n\nKeep backups & review [deletion](account-deletion.md#removal), [contact](mailto:abuse@crykit.lasers.app), and [provider](https://example.org/privacy?a=1&b=2).\n\n## Retention\n\nA separate section.\n'
const plain = node => node.nodeName === '#text' ? node.value : (node.childNodes ?? []).map(plain).join('')
const normalize = text => text.replace(/\s+/g, ' ').trim()
function nodes(html) {
  const found = []
  function visit(node) { found.push(node); for (const child of node.childNodes ?? []) visit(child) }
  visit(parse(html))
  return found
}
const attr = (node, name) => node.attrs?.find(attribute => attribute.name === name)?.value

async function fixture(run, source = SOURCE) {
  const directory = await mkdtemp(join(tmpdir(), 'crykit-privacy-page-'))
  await mkdir(join(directory, 'docs'))
  await writeFile(join(directory, 'docs/accounts-privacy.md'), source)
  await writeFile(join(directory, 'index.html'), '<!doctype html><html><head><title>App</title></head><body>App</body></html>')
  const config = { root: directory, configFile: false, publicDir: false, logLevel: 'silent', plugins: [privacyPagePlugin(), offlinePlugin({ publicAssets: [] })], build: { outDir: join(directory, 'output') } }
  try { await run({ directory, config, compile: async (base = './') => {
    await build({ ...config, base })
    return { html: await readFile(join(directory, 'output/privacy/index.html'), 'utf8'), css: await readFile(join(directory, 'output/privacy/privacy.css'), 'utf8'), worker: await readFile(join(directory, 'output/sw.js'), 'utf8') }
  } }) } finally { await rm(directory, { recursive: true, force: true }) }
}

test('actual repository privacy Markdown becomes complete standalone semantic HTML without app scripts', async () => {
  const source = await readFile(new URL('../docs/accounts-privacy.md', import.meta.url), 'utf8')
  await fixture(async ({ compile }) => {
    const output = await compile()
    const all = nodes(output.html)
    const article = all.find(node => node.tagName === 'article')
    assert.ok(article)
    assert.equal(normalize(plain(article)), normalize(plain(parse(marked.parse(source)))))
    assert.equal(all.filter(node => node.tagName === 'h1').length, 1)
    assert.equal(all.filter(node => node.tagName === 'script').length, 0)
    assert.ok(all.some(node => node.tagName === 'main' && attr(node, 'id') === 'content'))
    assert.ok(all.some(node => node.tagName === 'a' && attr(node, 'href') === '#content'))
    assert.ok(all.some(node => node.tagName === 'nav' && attr(node, 'aria-label') === 'On this page'))
    assert.ok(all.some(node => node.tagName === 'link' && attr(node, 'href') === './privacy.css'))
    assert.match(output.css, /:focus-visible/)
  }, source)
})

test('standalone branding uses the actual local crystal, cricket, and menu font under nested bases', async () => {
  await fixture(async ({ compile, directory }) => {
    const output = await compile('/nested/app/')
    const all = nodes(output.html)
    const header = all.find(node => node.tagName === 'header')
    assert.match(normalize(plain(header)), /Crystal Kit.*A Crystal Project planner/)
    const images = all.filter(node => node.tagName === 'img')
    assert.deepEqual(images.map(node => attr(node, 'src')), ['./crystal-icon.svg', './crystal-cricket.svg'])
    for (const image of images) { assert.equal(attr(image, 'alt'), ''); assert.ok(attr(image, 'width')); assert.ok(attr(image, 'height')) }
    const policy = attr(all.find(node => node.tagName === 'meta' && attr(node, 'http-equiv') === 'Content-Security-Policy'), 'content')
    assert.match(policy, /default-src 'none'/)
    assert.match(policy, /img-src 'self'/)
    assert.match(policy, /font-src 'self'/)
    assert.doesNotMatch(policy, /https?:|data:|unsafe-inline|script-src/)
    assert.match(output.css, /font-family: "Pixel Operator"/)
    assert.match(output.css, /url\(['"]?\.\/pixel-operator\.woff2/)
    const files = JSON.parse(output.worker.match(/const FILES = (\[[^;]+\]);/)[1])
    const groups = JSON.parse(output.worker.match(/const GROUPS = (\{[^;]+\});/)[1])
    for (const [filename, source] of [['crystal-icon.svg', '../public/icon.svg'], ['crystal-cricket.svg', '../src/assets/crystal-cricket.svg'], ['pixel-operator.woff2', '../src/assets/fonts/pixel-operator.woff2'], ['pixel-operator-CC0.txt', '../public/pixel-operator-CC0.txt']]) {
      assert.deepEqual(await readFile(join(directory, 'output/privacy', filename)), await readFile(new URL(source, import.meta.url)))
      assert.ok(groups.core.includes(files.indexOf('privacy/' + filename)))
      const destination = new URL('./' + filename, 'https://example.test/nested/app/privacy/')
      assert.equal(destination.pathname, '/nested/app/privacy/' + filename)
    }
    assert.equal(all.filter(node => node.tagName === 'script').length, 0)
  })
})

test('headings have unique accessible anchors and links retain safe destinations under nested bases', async () => {
  await fixture(async ({ compile }) => {
    const { html } = await compile('/nested/app/')
    const all = nodes(html)
    const links = all.filter(node => node.tagName === 'a').map(node => attr(node, 'href'))
    assert.ok(links.includes('/nested/app/'))
    assert.ok(links.includes('https://github.com/j-256/crykit/blob/main/docs/account-deletion.md#removal'))
    assert.ok(links.includes('https://example.org/privacy?a=1&b=2'))
    assert.ok(links.includes('mailto:abuse@crykit.lasers.app'))
    assert.ok(links.includes('#retention'))
    assert.ok(links.includes('#retention-2'))
    assert.deepEqual(all.find(node => node.tagName === 'article').childNodes.filter(node => node.tagName === 'h2').map(node => attr(node, 'id')), ['retention', 'retention-2'])
    assert.equal(all.find(node => node.tagName === 'title').childNodes[0].value, 'Privacy & account terms | CryKit')
  })
})

test('unsafe Markdown, resource embeds and unsafe or escaping destinations stop the build', async () => {
  for (const source of ['<script>alert(1)</script>', 'Text <img src=x onerror=alert(1)>', '[unsafe](javascript:alert%281%29)', '[unsafe](javascript&#58;alert%281%29)', '[unsafe](data:text/html,payload)', '[unsafe](//example.org)', '[unsafe](../outside.md)', '[unsafe](%2e%2e/outside.md)', '![unreviewed](https://example.org/image.png)']) {
    await fixture(async ({ compile }) => { await assert.rejects(compile(), /privacy.*(HTML|link|image|heading)/i) }, '# Privacy\n\n' + source)
  }
})

test('authored headings cannot steal the keyboard skip-link target', async () => {
  await fixture(async ({ compile }) => {
    const all = nodes((await compile()).html)
    const targets = all.filter(node => attr(node, 'id') === 'content')
    assert.equal(targets.length, 1)
    assert.equal(targets[0].tagName, 'main')
    assert.ok(all.some(node => node.tagName === 'h2' && attr(node, 'id') === 'content-2'))
  }, '# Privacy\n\n## Content\n\nPolicy text.\n')
})

test('page and stylesheet enter the offline core and Markdown changes invalidate its identity', async () => {
  await fixture(async ({ compile, directory }) => {
    const first = await compile()
    const files = JSON.parse(first.worker.match(/const FILES = (\[[^;]+\]);/)[1])
    const groups = JSON.parse(first.worker.match(/const GROUPS = (\{[^;]+\});/)[1])
    for (const path of ['privacy/index.html', 'privacy/privacy.css']) { assert.ok(files.includes(path)); assert.ok(groups.core.includes(files.indexOf(path))) }
    await writeFile(join(directory, 'docs/accounts-privacy.md'), SOURCE + '\nA changed disclosure.\n')
    const second = await compile()
    assert.match(second.html, /A changed disclosure/)
    assert.notEqual(first.worker.match(/const CACHE_NAME = ([^;]+);/)[1], second.worker.match(/const CACHE_NAME = ([^;]+);/)[1])
  })
})

test('development serves canonical policy and CSS paths under root and nested bases', async () => {
  await fixture(async ({ config, directory }) => {
    for (const base of ['/', '/nested/app/']) {
      const server = await createServer({ ...config, base, server: { host: '127.0.0.1', port: 0 } })
      try {
        await server.listen()
        const origin = server.resolvedUrls.local[0]
        for (const path of ['privacy', 'privacy/index.html']) {
          const response = await fetch(new URL(path + '?review=1', origin), { redirect: 'manual' })
          assert.equal(response.status, 308)
          assert.equal(response.headers.get('location'), base + 'privacy/?review=1')
        }
        const response = await fetch(new URL('privacy/', origin))
        assert.equal(response.status, 200)
        assert.match(response.headers.get('content-type'), /text\/html/)
        const html = await response.text()
        assert.match(html, /Your <strong>private records<\/strong> stay yours/)
        assert.equal(nodes(html).filter(node => node.tagName === 'script').length, 0)
        const css = await fetch(new URL('privacy/privacy.css', origin))
        assert.equal(css.status, 200)
        assert.match(css.headers.get('content-type'), /text\/css/)
        assert.match(await css.text(), /:focus-visible/)
        for (const [filename, type, source] of [['crystal-icon.svg', 'image/svg+xml', '../public/icon.svg'], ['crystal-cricket.svg', 'image/svg+xml', '../src/assets/crystal-cricket.svg'], ['pixel-operator.woff2', 'font/woff2', '../src/assets/fonts/pixel-operator.woff2']]) {
          const resource = await fetch(new URL('privacy/' + filename, origin))
          assert.equal(resource.status, 200)
          assert.equal(resource.headers.get('content-type').split(';')[0], type)
          assert.deepEqual(Buffer.from(await resource.arrayBuffer()), await readFile(new URL(source, import.meta.url)))
        }
        await writeFile(join(directory, 'docs/accounts-privacy.md'), SOURCE + '\nUpdated development policy.\n')
        assert.match(await (await fetch(new URL('privacy/', origin))).text(), /Updated development policy/)
        const head = await fetch(new URL('privacy/', origin), { method: 'HEAD' })
        assert.equal(head.status, 200)
        assert.equal(await head.text(), '')
      } finally { await server.close() }
    }
  })
})
