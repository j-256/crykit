#!/usr/bin/env node
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, lstat, readFile, writeFile, rename, rm, realpath } from 'node:fs/promises'
import { resolve, join, dirname, extname, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'

const HOST = '127.0.0.1'
const DEFAULT_PORT = 4186
const MAX_FILE_BYTES = 32 * 1024 * 1024
const REQUIRED = ['index.html', 'sw.js', '_headers', 'admin/index.html', 'admin/confirm/index.html', 'admin/accept-invitation/index.html']
const HASHED = /(?:^|\/)assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9.]+$/
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = message => { throw Error(message) }

async function owned(path, directory = false) {
  const stat = await lstat(path)
  const correctType = directory ? stat.isDirectory() : stat.isFile()
  if (stat.isSymbolicLink() || stat.uid !== process.getuid() || !correctType) {
    fail('Review state is not an owned regular file/directory')
  }
  return stat
}

async function state({ root, cache }) {
  const checkout = await realpath(root)
  const base = cache ?? process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache')
  if (!isAbsolute(base)) fail('XDG cache path must be absolute')
  const path = join(base, 'crykit-review', hash(checkout).slice(0, 24))
  await mkdir(path, { recursive: true, mode: 0o700 })
  const stat = await owned(path, true)
  if (stat.mode & 0o077) fail('Review state directory must be private')
  return path
}

async function inventory(directory, prefix = '') {
  const files = Object.create(null)
  for (const name of (await readdir(directory)).sort()) {
    if (name === '.snapshot.json' || name.includes('\\')) fail('Unsupported build filename')
    const path = join(directory, name)
    const relative = prefix + name
    const stat = await lstat(path)
    if (stat.isSymbolicLink()) fail('Build symlinks are not allowed')
    if (stat.isDirectory()) {
      Object.assign(files, await inventory(path, relative + '/'))
    } else if (stat.isFile() && stat.size <= MAX_FILE_BYTES) {
      files[relative] = hash(await readFile(path))
    } else {
      fail('Build input must be a bounded regular file')
    }
  }
  return files
}

async function references(html) {
  const { parse } = await import('parse5')
  const found = []
  const walk = node => {
    if (node.attrs) {
      const attr = name => node.attrs.find(value => value.name === name)?.value
      let resource
      if (node.tagName === 'script' || node.tagName === 'img') resource = attr('src')
      if (node.tagName === 'link' && ['stylesheet', 'icon', 'modulepreload', 'manifest'].includes(attr('rel'))) resource = attr('href')
      if (resource) found.push(resource)
    }
    for (const child of node.childNodes ?? []) walk(child)
  }
  walk(parse(html))
  return found
}

async function validate(directory, files) {
  for (const path of REQUIRED) {
    if (!Object.hasOwn(files, path)) fail('Incomplete build: missing ' + path)
  }
  const entry = await readFile(join(directory, 'index.html'), 'utf8')
  if (!/<script\b[^>]*type=["']module["']/i.test(entry)) fail('Incomplete build: index module reference absent')
  const worker = await readFile(join(directory, 'sw.js'), 'utf8')
  const list = worker.match(/const FILES = (\[[^;]+\]);/)
  if (!list) fail('Offline manifest is missing')
  for (const path of JSON.parse(list[1])) {
    if (typeof path !== 'string' || !Object.hasOwn(files, path)) fail('Offline manifest reference is unavailable')
  }
  for (const path of Object.keys(files).filter(path => path.endsWith('.html'))) {
    const html = await readFile(join(directory, path), 'utf8')
    for (const reference of await references(html)) {
      const url = new URL(reference, 'http://review.invalid/' + path)
      if (url.origin === 'http://review.invalid' && !Object.hasOwn(files, decodeURIComponent(url.pathname.slice(1)))) {
        fail('HTML resource reference is unavailable: ' + path)
      }
    }
  }
}

async function pointer(session) {
  const path = join(session, 'current.json')
  await owned(path)
  const value = JSON.parse(await readFile(path, 'utf8'))
  const validHistory = Array.isArray(value.history) && value.history.length > 0
    && value.history.every(id => /^snapshot-[a-f0-9-]{36}$/.test(id))
  if (!validHistory || value.current !== value.history.at(-1)) fail('Invalid review publication record')
  return value
}

async function manifest(session, id) {
  const path = join(session, id, '.snapshot.json')
  await owned(path)
  return JSON.parse(await readFile(path, 'utf8'))
}

async function publish(session, dist) {
  const lock = join(session, 'publish.lock')
  try {
    await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 })
  } catch {
    fail('Publication is active or its lock is stale; stop and inspect the review session')
  }
  let stage
  try {
    const source = await lstat(dist)
    if (!source.isDirectory() || source.isSymbolicLink()) fail('Build source must be a regular directory')
    for (const path of REQUIRED) {
      const stat = await lstat(join(dist, path))
      if (!stat.isFile() || stat.isSymbolicLink()) fail('Incomplete build: expected regular required file')
    }
    const before = await inventory(dist)
    await validate(dist, before)
    stage = await mkdtemp(join(session, 'staging-'))
    for (const path of Object.keys(before)) {
      await mkdir(dirname(join(stage, path)), { recursive: true, mode: 0o700 })
      await writeFile(join(stage, path), await readFile(join(dist, path)), { mode: 0o600 })
    }
    const copied = await inventory(stage)
    const after = await inventory(dist)
    if (JSON.stringify(before) !== JSON.stringify(copied) || JSON.stringify(before) !== JSON.stringify(after)) {
      fail('Build changed during publication; prior snapshot retained')
    }
    await validate(stage, copied)
    let previous
    try {
      previous = await pointer(session)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      previous = { history: [] }
    }
    for (const id of previous.history) {
      const old = await manifest(session, id)
      for (const path of Object.keys(copied)) {
        if (HASHED.test(path) && Object.hasOwn(old, path) && old[path] !== copied[path]) {
          fail('Hashed asset collision; prior snapshot retained')
        }
      }
    }
    await writeFile(join(stage, '.snapshot.json'), JSON.stringify(copied), { mode: 0o600 })
    const id = 'snapshot-' + randomUUID()
    await rename(stage, join(session, id))
    stage = undefined
    const temporary = join(session, 'pointer-' + randomUUID())
    await writeFile(temporary, JSON.stringify({ current: id, history: [...previous.history, id] }), { flag: 'wx', mode: 0o600 })
    // One rename commits the complete snapshot and its retention history together
    // Existing requests and open tabs keep immutable bytes; no browser reload or storage reset occurs
    await rename(temporary, join(session, 'current.json'))
    return id
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true })
    await rm(lock, { force: true })
  }
}

async function active(directory) {
  const path = join(directory, 'active.json')
  await owned(path)
  const value = JSON.parse(await readFile(path, 'utf8'))
  if (!/^session-[A-Za-z0-9_-]+$/.test(value.session) || !Number.isInteger(value.pid) || value.pid < 1) {
    fail('Invalid active review session')
  }
  const session = join(directory, value.session)
  await owned(session, true)
  return { ...value, directory: session }
}

export async function publishReview({ root, dist, cache }) {
  const record = await active(await state({ root, cache }))
  try {
    process.kill(record.pid, 0)
  } catch {
    fail('Review server is not running; inspect stale session before restarting')
  }
  return publish(record.directory, dist)
}

function headers(source, path) {
  const result = {}
  let matches = false
  for (const line of source.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    if (!/^\s/.test(line)) {
      const pattern = line.trim()
      matches = pattern.endsWith('*') ? path.startsWith(pattern.slice(0, -1)) : path === pattern
    } else if (matches) {
      const at = line.indexOf(':')
      if (at < 0) fail('Invalid built response header')
      result[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim()
    }
  }
  return result
}

function finish(response, status, body = '', headers = {}) {
  response.writeHead(status, { 'cache-control': 'no-cache', ...headers })
  response.end(body)
}

async function serveRequest(request, response, { server, session, getManifest }) {
  if (!['GET', 'HEAD'].includes(request.method)) {
    finish(response, 405, '', { allow: 'GET, HEAD' })
    return
  }
  if (request.headers.host !== `${HOST}:${server.address().port}`) {
    finish(response, 403)
    return
  }
  const raw = request.url.split('?', 1)[0]
  let decoded
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    finish(response, 400)
    return
  }
  if (!decoded.startsWith('/') || decoded.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(decoded) || decoded.split('/').some(part => part === '.' || part === '..')) {
    finish(response, 400)
    return
  }
  let path = decoded.slice(1)
  if (path.split('/').some(part => part.startsWith('.') || part === '_headers')) {
    finish(response, 404)
    return
  }
  const published = await pointer(session)
  const current = await getManifest(published.current)
  const query = request.url.includes('?') ? '?' + request.url.split('?').slice(1).join('?') : ''
  if (path === 'index.html' || path.endsWith('/index.html')) {
    finish(response, 308, '', { location: '/' + path.slice(0, -'index.html'.length) + query })
    return
  }
  if (path === '' || path.endsWith('/')) {
    path += 'index.html'
  } else if (Object.hasOwn(current, path + '/index.html')) {
    finish(response, 308, '', { location: '/' + path + '/' + query })
    return
  }
  let selected = Object.hasOwn(current, path) ? published.current : undefined
  // Only content-addressed assets can cross snapshot boundaries
  // An unknown module must return 404 rather than HTML from the newest shell
  if (!selected && HASHED.test(path)) {
    for (const id of [...published.history].reverse()) {
      if (Object.hasOwn(await getManifest(id), path)) {
        selected = id
        break
      }
    }
  }
  if (!selected) {
    finish(response, 404)
    return
  }
  const body = await readFile(join(session, selected, path))
  const policy = headers(await readFile(join(session, published.current, '_headers'), 'utf8'), '/' + path)
  const cacheControl = HASHED.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache'
  response.writeHead(200, {
    ...policy,
    'content-type': MIME[extname(path)] ?? 'application/octet-stream',
    'content-length': body.length,
    'cache-control': cacheControl,
    'x-content-type-options': 'nosniff',
  })
  response.end(request.method === 'HEAD' ? undefined : body)
}

export async function startReview({ root, dist, cache, port = DEFAULT_PORT }) {
  const directory = await state({ root, cache })
  const record = join(directory, 'active.json')
  try {
    await lstat(record)
    fail('Active or stale review session exists; stop and inspect it before restarting')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const session = await mkdtemp(join(directory, 'session-'))
  await publish(session, dist)
  const manifests = new Map()
  const getManifest = async id => {
    if (!manifests.has(id)) manifests.set(id, await manifest(session, id))
    return manifests.get(id)
  }
  const server = createServer((request, response) => {
    const started = performance.now()
    void serveRequest(request, response, { server, session, getManifest }).catch(error => {
      const requestId = randomUUID()
      const reason = ['ENOENT', 'EACCES', 'ENOTDIR', 'EIO', 'EPERM'].includes(error?.code) ? error.code : 'INVALID_SNAPSHOT'
      console.error(JSON.stringify({ event: 'crykit-review-error', code: 'SNAPSHOT_READ_FAILED', reason, requestId, durationMs: Math.round(performance.now() - started) }))
      if (!response.headersSent) {
        finish(response, 503, 'Review snapshot unavailable', { 'x-crykit-review-request-id': requestId })
      } else {
        response.end()
      }
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, HOST, resolve)
  })
  try {
    await writeFile(record, JSON.stringify({ session: session.slice(directory.length + 1), pid: process.pid, port: server.address().port }), { flag: 'wx', mode: 0o600 })
  } catch (error) {
    await new Promise(resolve => server.close(resolve))
    throw error
  }
  let closed = false
  return {
    origin: `http://${HOST}:${server.address().port}`,
    async close() {
      if (closed) return
      closed = true
      await new Promise(resolve => server.close(resolve))
      const value = await active(directory)
      if (value.directory === session && value.pid === process.pid) await rm(record)
    },
  }
}

const HELP = `Usage: node scripts/review-server.mjs <serve|publish> [options]\nServe immutable completed CryKit builds without replacing files beneath open tabs.\n  -d, --dist DIRECTORY  Completed build directory (default: checkout dist)\n  -p, --port NUMBER     Serve port, 0 for an ephemeral test port (default: 4186)\n  -H, --host ADDRESS    Only 127.0.0.1 is accepted\n  -h, --help            Show help\nState: XDG_CACHE_HOME/crykit-review per checkout/session, or ~/.cache/crykit-review.\nRun npm run review:publish after a finished build. No HTTP mutation endpoint,\nautomatic reload, service-worker reset or browser data deletion is performed.\nRetained session snapshots remain after stop; remove only stopped session state.\nRequires npm ci and a complete build including index, SW, headers, and admin entries.\nExit: 0 success/clean stop, 1 runtime/publication failure, 2 usage, 3 dependency failure.\n`

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(resolve(process.argv[1]))).href) {
  let parsed
  try {
    parsed = parseArgs({
      options: {
        help: { type: 'boolean', short: 'h' },
        dist: { type: 'string', short: 'd' },
        port: { type: 'string', short: 'p' },
        host: { type: 'string', short: 'H' },
      },
      allowPositionals: true,
      strict: true,
    })
    if (parsed.values.help) {
      console.log(HELP)
      process.exit(0)
    }
    const command = parsed.positionals[0]
    const port = parsed.values.port === undefined ? DEFAULT_PORT : Number(parsed.values.port)
    if (parsed.positionals.length !== 1 || !['serve', 'publish'].includes(command)
      || parsed.values.host && parsed.values.host !== HOST
      || parsed.values.port !== undefined && !/^\d+$/.test(parsed.values.port)
      || !Number.isInteger(port) || port < 0 || port > 65535 || parsed.values.dist === '') {
      throw Error('usage')
    }
  } catch {
    console.error('Invalid review arguments; use --help')
    process.exit(2)
  }
  const root = resolve(import.meta.dirname, '..')
  const dist = resolve(root, parsed.values.dist ?? 'dist')
  try {
    if (parsed.positionals[0] === 'publish') {
      console.log(JSON.stringify({ snapshot: await publishReview({ root, dist }) }))
    } else {
      const server = await startReview({ root, dist, port: parsed.values.port === undefined ? DEFAULT_PORT : Number(parsed.values.port) })
      console.log(JSON.stringify({ origin: server.origin, pid: process.pid }))
      for (const signal of ['SIGINT', 'SIGTERM']) {
        process.once(signal, () => {
          void server.close().then(() => process.exit(0), () => process.exit(1))
        })
      }
    }
  } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND') {
      console.error('Review dependency is missing; run npm ci')
      process.exitCode = 3
    } else {
      console.error(error.message)
      process.exitCode = 1
    }
  }
}
