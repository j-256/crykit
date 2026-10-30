import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareOpaqueWorkerModule } from './opaque-worker-module.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(root, '.account-tests')
const wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js')
const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node scripts/build-account-tests.mjs [--dev | --prepare-opaque]\nBuild local and production account test bundles with pinned Wrangler. --dev builds the browser and starts loopback Wrangler with generated local secrets. CRYKIT_ACCOUNTS_PORT selects the --dev loopback port (default 8787, range 1-65535). CRYKIT_ACCOUNTS_HTTPS=1 enables local HTTPS using a disposable OpenSSL certificate (requires openssl; no trust-store changes). Local secrets and an isolated migrated database are generated for each dev invocation. --prepare-opaque regenerates only the reviewed static-WASM adapter for Wrangler custom builds. Requires npm ci. Exit: 0 success, 1 build/runtime failure, 2 invalid arguments, 3 missing dependencies.')
  process.exit(0)
}
if (args.some(arg => arg !== '--dev' && arg !== '--prepare-opaque') || args.length > 1) { console.error('Unknown arguments; use --help'); process.exit(2) }
if (!existsSync(wrangler) || !existsSync(resolve(root, 'node_modules/@serenity-kit/opaque/esm/index.js'))) { console.error('Pinned account build dependencies are missing; run npm ci'); process.exit(3) }
await mkdir(output, { recursive: true })
const opaque = prepareOpaqueWorkerModule(await readFile(resolve(root, 'node_modules/@serenity-kit/opaque/esm/index.js'), 'utf8'))
await writeFile(resolve(output, 'opaque-runtime.js'), opaque.javascript)
await writeFile(resolve(output, 'opaque.wasm'), opaque.wasm)
// Retain the upstream notice next to generated modules
await writeFile(resolve(output, 'OPAQUE-LICENSE'), await readFile(resolve(root, 'node_modules/@serenity-kit/opaque/LICENSE')))
if (args.includes('--prepare-opaque')) process.exit(0)
const commandEnv = { ...process.env, WRANGLER_SEND_METRICS: 'false' }
function wranglerRun(args) { execFileSync(process.execPath, [wrangler, ...args], { cwd: root, env: commandEnv, stdio: 'inherit' }) }
if (args.includes('--dev')) {
  // Secrets are unique to this local process and never read from provider or production stores
  const port = process.env.CRYKIT_ACCOUNTS_PORT ?? '8787'
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) { console.error('CRYKIT_ACCOUNTS_PORT must be a valid TCP port'); process.exit(2) }
  const https = process.env.CRYKIT_ACCOUNTS_HTTPS === '1'
  const protocol = https ? 'https' : 'http'
  const tlsArgs = []
  if (https) {
    try { execFileSync('openssl', ['version'], { stdio: 'ignore' }) } catch { console.error('Local HTTPS requires openssl'); process.exit(3) }
    const tls = await mkdtemp(resolve(output, 'dev-tls-'))
    const key = resolve(tls, 'key.pem'), cert = resolve(tls, 'cert.pem'), config = resolve(tls, 'openssl.cnf')
    await writeFile(config, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n')
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', config, '-keyout', key, '-out', cert], { stdio: 'ignore' })
    tlsArgs.push('--local-protocol', 'https', '--https-key-path', key, '--https-cert-path', cert)
  }
  const secrets = ['SESSION_SECRET', 'CURSOR_SECRET', 'CAPABILITY_SECRET', 'EMAIL_STATE_SECRET', 'DUMMY_IDENTITY_SECRET'].map(name => `${name}=${randomBytes(32).toString('base64url')}`).join('\n')
  const varsPath = resolve(output, `dev-${port}.vars`)
  const { ready, server } = await import('@serenity-kit/opaque')
  await ready
  await writeFile(varsPath, `OPAQUE_SERVER_SETUP=${server.createSetup()}\n` + secrets + `\nSERVICE_ORIGIN=${protocol}://127.0.0.1:${port}\n`, { mode: 0o600 })
  execFileSync('npm', ['run', 'build:assets'], { cwd: root, stdio: 'inherit' })
  execFileSync('npm', ['exec', 'vite', 'build', '--', '--config', 'vite.accounts.config.ts'], { cwd: root, stdio: 'inherit' })
  await rename(resolve(output, 'browser/crypto-proof.html'), resolve(output, 'browser/index.html'))
  // Local probes must never enter dist, which existing deployment commands can publish directly
  const localAssets = resolve(output, 'dev-assets')
  await rm(localAssets, { recursive: true, force: true })
  await cp(resolve(root, 'dist'), localAssets, { recursive: true })
  await cp(resolve(output, 'browser'), resolve(localAssets, '__accounts-proof'), { recursive: true })
  const state = await mkdtemp(resolve(output, 'dev-state-'))
  wranglerRun(['d1', 'migrations', 'apply', 'DB', '--config', 'wrangler.local.jsonc', '--env-file', varsPath, '--local', '--persist-to', state])
  const child = spawn(process.execPath, [wrangler, 'dev', '--config', 'wrangler.local.jsonc', '--env-file', varsPath, '--local', '--persist-to', state, '--port', port, '--assets', localAssets, ...tlsArgs], { cwd: root, env: commandEnv, stdio: 'inherit' })
  child.on('exit', code => { process.exitCode = code ?? 1 })
} else {
  wranglerRun(['types', '--config', 'wrangler.local.jsonc', relative(root, resolve(output, 'worker-configuration.d.ts'))])
  // Dry-run bundling needs an assets directory, but never mutates the ordinary browser build
  const assets = resolve(output, 'assets')
  await mkdir(assets, { recursive: true })
  await writeFile(resolve(assets, 'index.html'), '<!doctype html><title>Local account fixture</title>')
  // A minimal exported function makes the collected WASM path executable in runtime tests
  await writeFile(resolve(output, 'probe.wasm'), new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,127,3,2,1,0,7,10,1,6,97,110,115,119,101,114,0,0,10,6,1,4,0,65,42,11]))
  await writeFile(resolve(output, 'wasm-entry.ts'), `import wasm from './probe.wasm'\nexport default { fetch() { const instance = new WebAssembly.Instance(wasm); return Response.json({ answer: instance.exports.answer() }) } }\n`)
  await writeFile(resolve(output, 'opaque-server-entry.ts'), `import { opaqueProbe } from '../worker/testing/opaque-probe'\nexport default { fetch: opaqueProbe }\n`)
  async function buildBundle(name, entry, config = 'wrangler.local.jsonc') {
    const directory = resolve(output, name)
    // Discard only regenerable bundles so removed imports cannot leave stale manifest modules
    await rm(directory, { recursive: true, force: true })
    await new Promise((resolveBuild, rejectBuild) => {
      const child = spawn(process.execPath, [wrangler, 'deploy', entry, '--config', config, '--dry-run', '--outdir', relative(root, directory), '--metafile', relative(root, resolve(directory, 'bundle-meta.json')), '--assets', assets], { cwd: root, env: commandEnv, stdio: 'inherit' })
      child.once('error', rejectBuild)
      child.once('close', (code, signal) => code === 0 ? resolveBuild() : rejectBuild(new Error(`Account bundle ${name} failed (${signal ?? code})`)))
    })
    const metadata = JSON.parse(await readFile(resolve(directory, 'bundle-meta.json'), 'utf8'))
    const entries = Object.entries(metadata.outputs).filter(([, details]) => details.entryPoint)
    if (entries.length !== 1) throw new Error(`Expected one Wrangler entry for ${name}`)
    const main = resolve(root, entries[0][0])
    if (!entries[0][1].exports.includes('default')) throw new Error('Worker entry must export a default handler')
    const modules = [{ type: 'ESModule', path: main }]
    // Wrangler emits collected WASM/data modules beside the metadata-selected main module
    async function collect(directoryPath) {
      for (const item of await readdir(directoryPath, { withFileTypes: true })) {
        const path = resolve(directoryPath, item.name)
        if (item.isDirectory()) await collect(path)
        else if (path !== main && /\.(wasm|bin|txt)$/.test(path)) modules.push({ type: path.endsWith('.wasm') ? 'CompiledWasm' : path.endsWith('.txt') ? 'Text' : 'Data', path })
      }
    }
    await collect(directory)
    await writeFile(resolve(directory, 'manifest.json'), JSON.stringify({ entryPoint: entries[0][1].entryPoint, modules, inputs: Object.keys(metadata.inputs) }, null, 2) + '\n')
  }
  async function buildLocalBundles() {
    // This config's custom build rewrites shared OPAQUE files, so its bundles must remain serial
    for (const [name, entry] of [['local', 'worker/testing/local-entry.ts'], ['production', 'worker/index.ts'], ['wasm', '.account-tests/wasm-entry.ts'], ['opaque-adapter', '.account-tests/opaque-server-entry.ts']]) await buildBundle(name, entry)
  }
  // Alerts has an independent config and output without the shared OPAQUE custom build
  // Drain both groups on failure so no child can overwrite output after verification releases ownership
  const results = await Promise.allSettled([buildLocalBundles(), buildBundle('alerts', 'worker/alerts/index.ts', 'wrangler.alerts.example.jsonc')])
  const failures = results.filter(result => result.status === 'rejected')
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Account test bundle preparation failed')
}
