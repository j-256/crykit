import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, access, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { startReview, publishReview } from './review-server.mjs'

async function build(directory, version) {
  await rm(directory, { recursive: true, force: true })
  const files = { 'index.html': `<script type="module" src="/assets/main-${version.repeat(8)}.js"></script>Build ${version}`, 'sw.js': `const FILES = ${JSON.stringify(['index.html', `assets/main-${version.repeat(8)}.js`])};`, '_headers': "/*\n  Referrer-Policy: no-referrer\n", [`assets/main-${version.repeat(8)}.js`]: `export const build='${version}'`, 'privacy/index.html': 'Terms ' + version, 'privacy/privacy.css': 'body{color:black}', 'admin/index.html': 'Admin', 'admin/confirm/index.html': 'Confirmation', 'admin/accept-invitation/index.html': 'Invitation', [`admin/assets/admin-${version.repeat(8)}.js`]: 'admin ' + version }
  for (const [path, body] of Object.entries(files)) { await mkdir(join(directory, path, '..'), { recursive: true }); await writeFile(join(directory, path), body) }
}
test('immutable review publication retains old assets and rejects incomplete builds without disturbing current state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'crykit-review-test-')), dist = join(root, 'dist'), cache = join(root, 'cache')
  await build(dist, 'A')
  const server = await startReview({ root, dist, cache, port: 0 })
  try {
    const origin = server.origin
    const get = path => fetch(origin + path, { redirect: 'manual' })
    assert.match(await (await get('/')).text(), /Build A/)
    await writeFile(join(dist, 'index.html'), 'partial build')
    assert.match(await (await get('/')).text(), /Build A/)
    await assert.rejects(publishReview({ root, dist, cache }), /offline|manifest|reference/i)
    assert.match(await (await get('/')).text(), /Build A/)
    await build(dist, 'B')
    await assert.rejects(access(join(dist, 'assets/main-AAAAAAAA.js')))
    await assert.rejects(access(join(dist, 'admin/assets/admin-AAAAAAAA.js')))
    await publishReview({ root, dist, cache })
    assert.match(await (await get('/')).text(), /Build B/)
    for (const path of ['/assets/main-AAAAAAAA.js', '/admin/assets/admin-AAAAAAAA.js']) { const response = await get(path); assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /javascript/); assert.match(await response.text(), /A/) }
    assert.equal((await get('/assets/missing-12345678.js')).status, 404)
    const module = await get('/assets/main-BBBBBBBB.js?review=1'); assert.equal(module.status, 200); assert.match(module.headers.get('content-type'), /javascript/)
    const head = await fetch(origin + '/assets/main-BBBBBBBB.js', { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '')
    for (const path of ['/', '/sw.js', '/privacy/']) assert.match((await get(path)).headers.get('cache-control'), /no-cache/)
    const redirect = await get('/privacy?from=account'); assert.equal(redirect.status, 308); assert.equal(redirect.headers.get('location'), '/privacy/?from=account')
    assert.equal(await (await get('/privacy/')).text(), 'Terms B')
    assert.equal((await get('/%2e%2e%2fsecret')).status, 400)
    assert.equal((await get('/_headers')).status, 404)
    assert.equal((await get('/%ZZ')).status, 400)
    assert.equal((await get('/%2Fexample.org/index.html')).status, 400)
    assert.equal((await get('//example.org/index.html')).status, 400)
    const indexRedirect = await get('/privacy/index.html?from=account')
    assert.equal(indexRedirect.status, 308)
    assert.equal(indexRedirect.headers.get('location'), '/privacy/?from=account')
    assert.equal((await fetch(origin, { method: 'POST' })).status, 405)
  } finally { await server.close() }
})
test('publication rejects symlinks, hashed path collisions and concurrent session ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'crykit-review-safety-')), dist = join(root, 'dist'), cache = join(root, 'cache')
  await build(dist, 'A')
  const server = await startReview({ root, dist, cache, port: 0 })
  try {
    await assert.rejects(startReview({ root, dist, cache, port: 0 }), /active|session/i)
    await writeFile(join(dist, 'assets/main-AAAAAAAA.js'), 'changed same hashed path')
    await assert.rejects(publishReview({ root, dist, cache }), /collision/i)
    assert.match(await (await fetch(server.origin + '/assets/main-AAAAAAAA.js')).text(), /build='A'/)
    const { symlink } = await import('node:fs/promises'); await symlink('/etc/hosts', join(dist, 'unsafe'))
    await assert.rejects(publishReview({ root, dist, cache }), /symlink|regular/i)
  } finally { await server.close() }
})

async function snapshotDirectory(root, cache) {
  const key = createHash('sha256').update(await realpath(root)).digest('hex').slice(0, 24)
  const directory = join(cache, 'crykit-review', key)
  const record = JSON.parse(await readFile(join(directory, 'active.json'), 'utf8'))
  const session = join(directory, record.session)
  const published = JSON.parse(await readFile(join(session, 'current.json'), 'utf8'))
  return join(session, published.current)
}

test('raw request paths cannot select unpublished files or escape a snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'crykit-review-paths-'))
  const dist = join(root, 'dist'), cache = join(root, 'cache')
  await build(dist, 'A')
  await writeFile(join(dist, 'safe name.txt'), 'Published name')
  await writeFile(join(root, 'private.txt'), 'SYNTHETIC_PRIVATE_MARKER')
  const server = await startReview({ root, dist, cache, port: 0 })
  try {
    await writeFile(join(await snapshotDirectory(root, cache), 'unpublished.txt'), 'SYNTHETIC_PRIVATE_MARKER')
    // Keep traversal bytes intact instead of letting a URL client normalize them before sending
    const get = path => new Promise((resolve, reject) => {
      const request = httpRequest(server.origin, { path }, response => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', chunk => { body += chunk })
        response.on('end', () => resolve({ status: response.statusCode, body }))
        response.on('error', reject)
      })
      request.on('error', reject)
      request.end()
    })
    for (const path of ['/../private.txt', '/assets/%2e%2e/%2e%2e/private.txt', '/%2e%2e%2fprivate.txt', '/assets%5c..%5cprivate.txt', '/%00private.txt']) {
      const response = await get(path)
      assert.equal(response.status, 400, path)
      assert.doesNotMatch(response.body, /SYNTHETIC_PRIVATE_MARKER/)
    }
    for (const path of ['/unpublished.txt', '/%252e%252e%252fprivate.txt', '/.snapshot.json', '/_headers']) assert.equal((await get(path)).status, 404, path)
    assert.deepEqual(await get('/%73afe%20name.txt'), { status: 200, body: 'Published name' })
  } finally { await server.close() }
})

test('unsafe snapshot route manifests fail before any file is served', async () => {
  const root = await mkdtemp(join(tmpdir(), 'crykit-review-manifest-'))
  const dist = join(root, 'dist'), cache = join(root, 'cache')
  await build(dist, 'A')
  const server = await startReview({ root, dist, cache, port: 0 })
  const logging = mock.method(console, 'error', () => {})
  try {
    const path = join(await snapshotDirectory(root, cache), '.snapshot.json')
    const original = JSON.parse(await readFile(path, 'utf8'))
    for (const name of ['../private.txt', '/private.txt', 'nested/../private.txt', 'nested//private.txt', 'nested\\private.txt']) {
      await writeFile(path, JSON.stringify({ ...original, [name]: 'a'.repeat(64) }))
      assert.equal((await fetch(server.origin)).status, 503, name)
    }
    await writeFile(path, JSON.stringify({ ...original, 'bad-hash.txt': 'not-a-digest' }))
    assert.equal((await fetch(server.origin)).status, 503)
    await writeFile(path, JSON.stringify(original))
    assert.match(await (await fetch(server.origin)).text(), /Build A/)
  } finally { logging.mock.restore(); await server.close() }
})

test('publication rejects unservable filenames before replacing the current snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'crykit-review-invalid-name-'))
  const dist = join(root, 'dist'), cache = join(root, 'cache')
  await build(dist, 'A')
  const server = await startReview({ root, dist, cache, port: 0 })
  try {
    assert.match(await (await fetch(server.origin)).text(), /Build A/)
    await build(dist, 'B')
    await writeFile(join(dist, 'bad\nname.txt'), 'Unservable filename')
    await assert.rejects(publishReview({ root, dist, cache }), /filename/)
    assert.match(await (await fetch(server.origin)).text(), /Build A/)
    assert.equal((await fetch(server.origin + '/assets/main-BBBBBBBB.js')).status, 404)
    await rm(join(dist, 'bad\nname.txt'))
    await publishReview({ root, dist, cache })
    assert.match(await (await fetch(server.origin)).text(), /Build B/)
  } finally { await server.close() }
})
test('CLI help and invalid arguments are explicit without starting a server', () => {
  for (const flag of ['-h', '--help']) { const result = spawnSync(process.execPath, ['scripts/review-server.mjs', flag], { encoding: 'utf8' }); assert.equal(result.status, 0); assert.match(result.stdout, /publish/); assert.equal(result.stderr, '') }
  for (const args of [[], ['unknown'], ['serve', '--port='], ['serve', '--host', '0.0.0.0'], ['serve', '--port', '65536'], ['publish', '--unknown']]) assert.equal(spawnSync(process.execPath, ['scripts/review-server.mjs', ...args]).status, 2)
})

test('source changes after staging starts reject publication and retain the previous snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'crykit-review-changing-'))
  const dist = join(root, 'dist')
  const cache = join(root, 'cache')
  await build(dist, 'A')
  const server = await startReview({ root, dist, cache, port: 0 })
  try {
    await build(dist, 'B')
    for (let index = 0; index < 100; index++) await writeFile(join(dist, `padding-${index}.txt`), 'stable'.repeat(1000))
    const key = createHash('sha256').update(await realpath(root)).digest('hex').slice(0, 24)
    const state = join(cache, 'crykit-review', key)
    const record = JSON.parse(await readFile(join(state, 'active.json'), 'utf8'))
    const changed = (async () => {
      for (let attempt = 0; attempt < 1000; attempt++) {
        const names = await (await import('node:fs/promises')).readdir(join(state, record.session))
        if (names.some(name => name.startsWith('staging-'))) {
          await writeFile(join(dist, 'padding-99.txt'), 'changed during copy')
          return
        }
        await delay(1)
      }
      assert.fail('Publication did not expose its staging phase')
    })()
    const rejected = assert.rejects(publishReview({ root, dist, cache }), /changed during publication/)
    await changed
    await rejected
    assert.match(await (await fetch(server.origin + '/')).text(), /Build A/)
  } finally { await server.close() }
})

test('help works without dependencies and a valid serve reports missing dependency separately', async () => {
  const root = await mkdtemp(join(tmpdir(), 'crykit-review-dependency-'))
  const scripts = join(root, 'scripts')
  await mkdir(scripts)
  const entry = join(scripts, 'review-server.mjs')
  await writeFile(entry, await readFile('scripts/review-server.mjs'))
  const dist = join(root, 'dist')
  await build(dist, 'A')
  const options = { encoding: 'utf8', env: { ...process.env, XDG_CACHE_HOME: join(root, 'cache') } }
  const help = spawnSync(process.execPath, [entry, '--help'], options)
  assert.equal(help.status, 0)
  assert.match(help.stdout, /Usage:/)
  const missing = spawnSync(process.execPath, [entry, 'serve', '--dist', dist, '-p0'], options)
  assert.equal(missing.status, 3)
  assert.match(missing.stderr, /dependency.*missing/)
})

test('snapshot read failures expose a safe diagnostic correlation without URL or query data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'crykit-review-diagnostic-'))
  const dist = join(root, 'dist'), cache = join(root, 'cache')
  await build(dist, 'A')
  const server = await startReview({ root, dist, cache, port: 0 })
  const events = []
  const logging = mock.method(console, 'error', value => events.push(JSON.parse(value)))
  try {
    const key = createHash('sha256').update(await realpath(root)).digest('hex').slice(0, 24)
    const record = JSON.parse(await readFile(join(cache, 'crykit-review', key, 'active.json'), 'utf8'))
    await writeFile(join(cache, 'crykit-review', key, record.session, 'current.json'), '{')
    const response = await fetch(server.origin + '/private?password=SYNTHETIC_PASSWORD')
    assert.equal(response.status, 503)
    assert.equal(events.length, 1)
    assert.equal(events[0].requestId, response.headers.get('x-crykit-review-request-id'))
    assert.equal(events[0].code, 'SNAPSHOT_READ_FAILED')
    assert.ok(events[0].durationMs >= 0)
    assert.doesNotMatch(JSON.stringify(events), /private|SYNTHETIC_PASSWORD|password=/)
  } finally { logging.mock.restore(); await server.close() }
})
