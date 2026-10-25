import { execFileSync } from 'node:child_process'
import { createServer } from 'node:https'
import { randomBytes } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, extname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

let options
try { options = parseArgs({ options: { help: { type: 'boolean', short: 'h' } }, strict: true }).values }
catch { console.error('Invalid arguments; use --help'); process.exit(2) }
if (options.help) {
  console.log('Usage: node scripts/serve-account-acceptance.mjs\nServe immutable synthetic account acceptance assets on HTTPS loopback. Requires npm ci, openssl, build:assets, build:account-tests and a vite.accounts.config.ts build. CRYKIT_ACCOUNTS_PORT is a TCP port (default 8797; 0 selects an owned ephemeral port). CRYKIT_ACCOUNT_INPUTS optionally names an immutable acceptance snapshot prepared by the test setup. Prints one ready JSON record with origin, public TLS certificate, pid and retained fixture directory to stdout. Copies builds into a fresh .account-tests/acceptance-* directory and retains it after shutdown. No provider credentials, external email, source watchers or shared development state are used. Exit: 0 clean shutdown, 1 runtime failure, 2 invalid arguments or missing build inputs, 3 missing dependency.')
  process.exit(0)
}
const port = process.env.CRYKIT_ACCOUNTS_PORT ?? '8797'
if (!/^\d+$/.test(port) || Number(port) > 65535) { console.error('Invalid arguments or CRYKIT_ACCOUNTS_PORT; use --help'); process.exit(2) }
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), output = resolve(root, '.account-tests')
try { execFileSync('openssl', ['version'], { stdio: 'ignore' }) } catch { console.error('Account acceptance HTTPS requires openssl'); process.exit(3) }
let Miniflare, convertV4MiniflareOptions, LocalResponse, splitSqlQuery, opaque
try {
  ;({ Miniflare, convertV4MiniflareOptions, Response: LocalResponse } = await import('miniflare'))
  ;({ unstable_splitSqlQuery: splitSqlQuery } = await import('wrangler'))
  opaque = await import('@serenity-kit/opaque')
} catch { console.error('Pinned account dependencies are missing; run npm ci'); process.exit(3) }
try {
  await Promise.all(['dist/index.html', '.account-tests/browser/crypto-proof.html', '.account-tests/local/manifest.json', '.account-tests/production/manifest.json', '.account-tests/wasm/manifest.json', '.account-tests/opaque-adapter/manifest.json'].map(name => readFile(resolve(root, name))))
} catch { console.error('Missing built acceptance inputs; run build:assets, build:account-tests and vite build --config vite.accounts.config.ts'); process.exit(2) }
await mkdir(output, { recursive: true })
const directory = await mkdtemp(resolve(output, 'acceptance-'))
// Publication prepares one immutable input snapshot; each runtime still owns its TLS and storage
const inputDirectory = process.env.CRYKIT_ACCOUNT_INPUTS ?? directory
const assets = resolve(inputDirectory, 'assets')
if (!process.env.CRYKIT_ACCOUNT_INPUTS) {
  await cp(resolve(root, 'dist'), assets, { recursive: true })
  await cp(resolve(output, 'browser'), resolve(assets, '__accounts-proof'), { recursive: true })
  await cp(resolve(assets, '__accounts-proof/crypto-proof.html'), resolve(assets, '__accounts-proof/index.html'))
}
const bundles = {}
for (const name of ['local', 'production', 'wasm', 'opaque-adapter']) {
  const source = resolve(output, name), target = resolve(inputDirectory, name)
  if (!process.env.CRYKIT_ACCOUNT_INPUTS) await cp(source, target, { recursive: true })
  const manifest = JSON.parse(await readFile(resolve(target, 'manifest.json'), 'utf8'))
  bundles[name] = manifest.modules.map(module => ({ ...module, path: resolve(target, relative(source, module.path)) }))
}
const config = resolve(directory, 'openssl.cnf'), key = resolve(directory, 'key.pem'), cert = resolve(directory, 'cert.pem')
await writeFile(config, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n')
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', config, '-keyout', key, '-out', cert], { stdio: 'ignore' })
// Bind before creating Worker bindings so Origin validation uses the actual owned port
const server = createServer({ key: await readFile(key), cert: await readFile(cert) })
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(port), '127.0.0.1', resolve) })
const origin = `https://127.0.0.1:${server.address().port}`, emails = []
const measurement = { workerRequests: 0 }
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.webmanifest': 'application/manifest+json' }
// Apply the actual built static policy to copied assets, including proof pages
const staticHeaders = []
let rule
for (const line of (await readFile(resolve(assets, '_headers'), 'utf8')).split('\n')) {
  if (line.startsWith('/')) { rule = { path: line.trim(), headers: {} }; staticHeaders.push(rule) }
  else if (rule && /^\s+[^:]+:/.test(line)) { const split = line.indexOf(':'); rule.headers[line.slice(0, split).trim()] = line.slice(split + 1).trim() }
}
async function asset(request) {
  const url = new URL(request.url)
  const path = resolve(assets, '.' + decodeURIComponent(url.pathname), url.pathname.endsWith('/') ? 'index.html' : '')
  if (!path.startsWith(assets + '/')) return new LocalResponse('Not found', { status: 404 })
  const headers = { 'content-type': mime[extname(path)] ?? 'application/octet-stream' }
  for (const rule of staticHeaders) if (rule.path.endsWith('*') ? url.pathname.startsWith(rule.path.slice(0, -1)) : url.pathname === rule.path) Object.assign(headers, rule.headers)
  // Cloudflare static HTML routing accepts the extensionless account UI fixture route
  for (const candidate of extname(path) ? [path] : [path, `${path}.html`]) {
    try { return new LocalResponse(await readFile(candidate), { headers: { ...headers, 'content-type': mime[extname(candidate)] ?? 'application/octet-stream' } }) }
    catch (error) { if (error.code !== 'ENOENT' && error.code !== 'EISDIR') throw error }
  }
  return new LocalResponse('Not found', { status: 404 })
}
await opaque.ready
// Use the same native limiter configuration as local Wrangler, frozen with the other inputs
const localConfiguration = JSON.parse(await readFile(resolve(process.env.CRYKIT_ACCOUNT_INPUTS ?? root, 'wrangler.local.jsonc'), 'utf8'))
const ratelimits = Object.fromEntries(localConfiguration.ratelimits.map(binding => [binding.name, { namespace_id: binding.namespace_id, simple: binding.simple }]))
const bindings = { ACCOUNTS_ACTIVE: 'true', SIGNUP_ACTIVE: 'true', SERVICE_ORIGIN: origin, STORAGE_CAP_BYTES: '2147483648', EMAIL_SENDING_ACTIVE: 'true', EMAIL_HEADROOM: 'available', OPAQUE_SERVER_SETUP: opaque.server.createSetup(), SERVICE_BACKUP_POLICY: '' }
for (const name of ['SERVICE_BACKUP_KEY', 'DUMMY_IDENTITY_SECRET', 'SESSION_SECRET', 'CURSOR_SECRET', 'CAPABILITY_SECRET', 'EMAIL_STATE_SECRET']) bindings[name] = randomBytes(32).toString('base64url')
const shared = {
  compatibilityDate: '2026-09-28', bindings, ratelimits, d1Databases: { DB: 'acceptance' }, r2Buckets: { OBJECTS: 'objects', LEDGER_BACKUPS: 'backups', REVOCATION_LEDGER: 'revocations' },
  outboundService: async () => new LocalResponse('Outbound disabled', { status: 503 }),
  serviceBindings: { ASSETS: asset, EMAIL: async request => {
    const message = await request.json()
    if (!/^[^@]+@example\.(com|org|net)$/.test(message.recipient)) return new LocalResponse('Forbidden', { status: 403 })
    emails.push(message)
    return LocalResponse.json({ messageId: `local-${emails.length}` })
  } },
}
// Every invocation owns fresh in-memory storage and copied modules; source writes cannot reset sessions
const mf = new Miniflare(convertV4MiniflareOptions({ host: '127.0.0.1', port: 0, workers: [
  { ...shared, name: 'local', modules: bundles.local, modulesRoot: resolve(inputDirectory, 'local'), serviceBindings: { ...shared.serviceBindings, PRODUCTION: 'production', WASM_PROBE: 'wasm', OPAQUE_ADAPTER: 'opaque-adapter' } },
  { ...shared, name: 'production', modules: bundles.production, modulesRoot: resolve(inputDirectory, 'production') },
  { ...shared, name: 'opaque-adapter', modules: bundles['opaque-adapter'], modulesRoot: resolve(inputDirectory, 'opaque-adapter') },
  { name: 'wasm', compatibilityDate: shared.compatibilityDate, modules: bundles.wasm, modulesRoot: resolve(inputDirectory, 'wasm') },
] }))
await mf.ready
const db = await mf.getD1Database('DB', 'local')
for (const name of (await readdir(resolve(root, 'worker/migrations'))).filter(name => /^\d+[-\w]*\.sql$/.test(name)).sort()) await db.batch(splitSqlQuery(await readFile(resolve(root, 'worker/migrations', name), 'utf8')).map(sql => db.prepare(sql)))
server.on('request', async (request, response) => {
  try {
    // Owned connectivity listeners preserve Host so strict admin origin checks see the browser's real origin
    // Only loopback authorities are accepted by this excluded synthetic HTTPS adapter
    const host = request.headers.host
    if (!host || !/^127\.0\.0\.1:\d+$/.test(host)) { response.writeHead(400).end(); return }
    const url = new URL(request.url, `https://${host}`)
    // Only aggregate authored event roles and byte totals; no payloads, identities or capabilities are retained
    if (url.pathname === '/__accounts/measurement') {
      // Read native aggregates only when a proof requests them, without per-request Node callbacks
      const telemetry = await mf.dispatchFetch('http://127.0.0.1/__accounts/probe/measurement')
      if (!telemetry.ok) throw new Error(`Local measurement rejected (${telemetry.status})`)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ...measurement, ...await telemetry.json(), processMemory: process.memoryUsage() }))
      return
    }
    if (url.pathname === '/__accounts/emails') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(emails)); return }
    const parts = []; for await (const part of request) parts.push(part)
    // Match wrangler.local run_worker_first; static precache requests cannot consume Worker invocations
    const workerFirst = url.pathname.startsWith('/api/') || url.pathname === '/admin' || url.pathname.startsWith('/admin/') || url.pathname.startsWith('/__accounts/')
    if (workerFirst) measurement.workerRequests++
    const result = !workerFirst ? await asset({ url: url.href }) : await mf.dispatchFetch(url.href, { method: request.method, headers: request.headers, ...(parts.length ? { body: Buffer.concat(parts) } : {}) })
    const headers = Object.fromEntries(result.headers), cookies = result.headers.getSetCookie()
    if (cookies.length) headers['set-cookie'] = cookies
    response.writeHead(result.status, headers)
    // Flush native Set-Cookie headers before a held body; buffering would invalidate lifecycle proofs
    response.flushHeaders()
    if (result.body) for await (const chunk of result.body) {
      if (!response.write(chunk)) await new Promise(resolve => response.once('drain', resolve))
    }
    response.end()
  } catch {
    if (!response.headersSent) response.writeHead(500)
    response.end('Isolated acceptance request failed')
  }
})
server.on('error', async error => { console.error(`Acceptance listener failed: ${error.code ?? 'runtime'}`); await mf.dispose(); process.exit(1) })
// The parent pins this public certificate; the private key remains inside the owned runtime
const ready = { origin, certificate: await readFile(cert, 'utf8'), pid: process.pid, directory, immutable: true, outboundEmail: false }
await writeFile(resolve(directory, 'runtime.json'), JSON.stringify(ready) + '\n')
const shutdown = async () => { server.closeAllConnections(); server.close(); await mf.dispose(); process.exit(0) }
process.on('message', message => { if (message?.type === 'crykit-account-stop') void shutdown().catch(() => process.exit(1)) })
console.log(JSON.stringify({ event: 'ready', ...ready }))
console.error(`Immutable account acceptance ready: ${origin}; retained fixture ${directory}`)
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, shutdown)
