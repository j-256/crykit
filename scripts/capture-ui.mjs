import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const PROJECT_DIRECTORY = resolve(SCRIPT_DIRECTORY, '..')
const SCREENS = JSON.parse(await readFile(join(SCRIPT_DIRECTORY, 'ui-review-screens.json'), 'utf8'))
const DEVICES = ['desktop', 'mobile']
const REVIEW_SERVER_TIMEOUT_MS = 10_000
const SHUTDOWN_GRACE_TIMEOUT_MS = 5000
const USAGE = `Usage: npm run screenshots -- [options]
Capture synthetic CryKit UI states in fresh Chromium desktop/mobile profiles.

Options:
  -h, --help             Show this help
  -l, --label NAME       Run label using letters, digits, underscores, or hyphens
  -o, --output ROOT      Output root; every run creates a new timestamped directory
  -u, --url URL          Existing loopback HTTP server; otherwise start isolated Vite
  -s, --screens IDS      Comma-separated screen IDs; default: all
  -d, --devices IDS      desktop,mobile or either device; default: both

Screen IDs:
${SCREENS.map(screen => `  ${screen.id.padEnd(21)} ${screen.label}`).join('\n')}

Output defaults to $XDG_DATA_HOME/crykit/ui-reviews, or
$HOME/.local/share/crykit/ui-reviews when XDG_DATA_HOME is unset.
Each run contains PNGs, manifest.json, index.html, and failure diagnostics.
Viewport images show unchanged layouts; full-content images stitch native
scroll regions when page screenshots cannot include their overflow.
No personal input files or existing browser profiles are accepted. Requests
outside the selected local server are blocked. No credentials are required.

Requires Node.js >=22.12, npm ci, and Playwright Chromium installed with
npx playwright install chromium. An owned Vite server is stopped after capture.
Progress goes to stderr; the absolute review directory goes to stdout.
Exit: 0 capture/help success, 1 capture failure, 2 invalid usage/precondition,
3 missing package/browser dependency.
`

export class CaptureUsageError extends Error {}

export function parseCaptureOptions(args, environment = process.env) {
  let parsed
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: {
      help: { type: 'boolean', short: 'h' }, label: { type: 'string', short: 'l' },
      output: { type: 'string', short: 'o' }, url: { type: 'string', short: 'u' },
      screens: { type: 'string', short: 's' }, devices: { type: 'string', short: 'd' },
    } })
  } catch (reason) { throw new CaptureUsageError(reason.message) }
  if (parsed.positionals.length) throw new CaptureUsageError(`Unexpected argument: ${parsed.positionals[0]}`)
  if (parsed.values.help) return { help: true }
  for (const [name, value] of Object.entries(parsed.values)) if (value === '') throw new CaptureUsageError(`--${name} requires a nonempty value`)
  const label = parsed.values.label ?? 'ui-review'
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(label)) throw new CaptureUsageError('--label must use letters, digits, underscores, or hyphens and start with a letter or digit')
  const select = (value, allowed, name) => {
    const choices = value === undefined ? allowed : value.split(',')
    if (!choices.length || choices.some(choice => !allowed.includes(choice))) throw new CaptureUsageError(`--${name} accepts: ${allowed.join(',')}`)
    return [...new Set(choices)]
  }
  let url
  if (parsed.values.url) {
    try { url = new URL(parsed.values.url) } catch { throw new CaptureUsageError('--url must be a valid loopback HTTP URL') }
    if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new CaptureUsageError('--url must be a loopback HTTP URL without credentials, query, or fragment')
    if (!url.pathname.endsWith('/')) url.pathname += '/'
  }
  const dataRoot = environment.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  return { label, output: resolve(parsed.values.output ?? join(dataRoot, 'crykit', 'ui-reviews')), url: url?.href,
    screens: select(parsed.values.screens, SCREENS.map(screen => screen.id), 'screens'), devices: select(parsed.values.devices, DEVICES, 'devices') }
}

export async function createRunDirectory(output, label, now = new Date()) {
  await mkdir(output, { recursive: true })
  const timestamp = now.toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z')
  // Exclusive creation prevents a fast repeated run from overwriting an earlier visual review
  for (let suffix = 0; ; suffix += 1) {
    const directory = join(output, `${timestamp}-${label}${suffix ? `-${suffix + 1}` : ''}`)
    try { await mkdir(directory); return directory } catch (reason) { if (reason.code !== 'EEXIST') throw reason }
  }
}

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

export function renderReviewIndex(manifest) {
  const cards = manifest.captures.map(capture => `<article><h2>${escapeHtml(capture.device)} / ${escapeHtml(capture.screen)} / ${escapeHtml(capture.state)}</h2><p>${escapeHtml(capture.description)}</p><a href="${escapeHtml(capture.viewport)}"><img loading="lazy" src="${escapeHtml(capture.viewport)}" alt="${escapeHtml(capture.state)} first viewport"></a><p><a href="${escapeHtml(capture.viewport)}">First viewport</a> | <a href="${escapeHtml(capture.fullContent)}">Full content</a></p></article>`).join('\n')
  const errors = manifest.failures.map(failure => `<li><strong>${escapeHtml(failure.device)} / ${escapeHtml(failure.screen)}</strong><pre>${escapeHtml(failure.error)}</pre>${failure.image ? `<a href="${escapeHtml(failure.image)}">Failure screenshot</a>` : ''}</li>`).join('\n')
  const source = manifest.source ? `<p>Source: ${escapeHtml(manifest.source.branch)} / commit <code>${escapeHtml(manifest.source.head)}</code> / tree <code>${escapeHtml(manifest.source.tree)}</code>. ${manifest.source.dirty ? 'Uncommitted changes were present.' : 'Clean checkout.'}${manifest.sourceChangedDuringCapture ? ' Source changed during capture; review the manifest before comparing runs.' : ''}</p>` : ''
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>CryKit UI review: ${escapeHtml(manifest.label)}</title><style>body{margin:24px;background:#171d22;color:#e7edf2;font:16px system-ui}a{color:#8bd1ec}h1{font-size:1.8rem}h2{font-size:1rem}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:24px}article{border:1px solid #77848d;padding:16px;min-width:0}img{width:100%;height:400px;object-fit:contain;object-position:top;background:#10161b}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>CryKit UI review: ${escapeHtml(manifest.label)}</h1><p>${escapeHtml(manifest.startedAt)}. Synthetic data only. ${escapeHtml(manifest.status)}.</p>${source}<p>First viewport images preserve the rendered layout. Full-content images include scrollable content, stitched from native viewports when needed. Open PNGs directly to compare details.</p>${errors ? `<h2>Capture failures</h2><ul>${errors}</ul>` : ''}<main>${cards}</main></html>\n`
}

async function availablePort() {
  const server = createServer()
  await new Promise((resolvePort, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolvePort) })
  const address = server.address()
  await new Promise((resolveClose, reject) => server.close(reason => reason ? reject(reason) : resolveClose()))
  if (!address || typeof address === 'string') throw new Error('Could not allocate a local screenshot server port')
  return address.port
}

export function sourceIdentity() {
  const branchResult = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: PROJECT_DIRECTORY, encoding: 'utf8' })
  const identity = spawnSync('git', ['rev-parse', 'HEAD', 'HEAD^{tree}'], { cwd: PROJECT_DIRECTORY, encoding: 'utf8' })
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: PROJECT_DIRECTORY, encoding: 'utf8' })
  const diff = spawnSync('git', ['diff', '--binary', 'HEAD'], { cwd: PROJECT_DIRECTORY, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: PROJECT_DIRECTORY, encoding: 'utf8' })
  if ([branchResult, identity, status, diff, untracked].some(result => result.status !== 0)) throw new Error('Could not record Git source identity for screenshot review')
  const branch = branchResult.stdout.trim()
  const [head, tree] = identity.stdout.trim().split('\n')
  const paths = untracked.stdout.split('\0').filter(Boolean).sort()
  let excludedFiles = 0
  const untrackedSources = paths.flatMap(path => {
    // Only source text belongs in identity checks; personal imports and screenshot pixels must never be read
    if (!isReviewSourcePath(path) || !lstatSync(join(PROJECT_DIRECTORY, path)).isFile()) { excludedFiles += 1; return [] }
    return [{ path, bytes: readFileSync(join(PROJECT_DIRECTORY, path)) }]
  })
  return { branch, head, tree, dirty: Boolean(status.stdout.trim()), excludedPrivateOrLinkedFiles: excludedFiles,
    workingChangesDigest: workingSourceDigest(status.stdout, diff.stdout, untrackedSources) }
}

export function isReviewSourcePath(path) {
  if (/^(?:src|scripts|e2e|docs|public)\/.*\.(?:ts|tsx|js|mjs|cjs|css|html|json|jsonc|md|svg)$/.test(path)) return !/(^|\/)(?:credentials|secrets?)(?:\.[^/]*)?$/i.test(path)
  return ['package.json', 'package-lock.json', 'index.html', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json'].includes(path) || /^[^/]+\.config\.(?:ts|js|mjs)$/.test(path)
}

export function workingSourceDigest(status, trackedDiff, untrackedSources) {
  const digest = createHash('sha256').update(status).update('\0').update(trackedDiff)
  for (const source of untrackedSources) digest.update('\0').update(source.path).update('\0').update(createHash('sha256').update(source.bytes).digest())
  return digest.digest('hex')
}

export async function captureProcess(command, args, options, signal) {
  return new Promise((resolveExit, reject) => {
    const child = spawn(command, args, { ...options, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    let interrupted = false
    let stopping
    const stop = () => {
      interrupted = true
      if (stopping || !child.pid) return
      // Playwright handles SIGINT by closing its browser workers; Vite is owned separately by this CLI
      child.kill('SIGINT')
      stopping = setTimeout(() => {
        try { if (process.platform === 'win32') child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL') } catch (reason) { if (reason.code !== 'ESRCH') process.stderr.write(`Capture shutdown failed: ${reason.message}\n`) }
      }, SHUTDOWN_GRACE_TIMEOUT_MS)
    }
    const cleanup = () => {
      signal?.removeEventListener('abort', stop)
      if (stopping) clearTimeout(stopping)
    }
    signal?.addEventListener('abort', stop, { once: true })
    if (signal?.aborted) stop()
    child.stdout.pipe(process.stderr)
    child.stderr.pipe(process.stderr)
    child.once('error', reason => { cleanup(); reject(reason) })
    child.once('close', (status, signal) => { cleanup(); resolveExit(interrupted || signal ? 1 : status ?? 1) })
  })
}

async function writeReview(directory, manifest) {
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(join(directory, 'index.html'), renderReviewIndex(manifest))
}

export async function runCapture(args = process.argv.slice(2)) {
  let options
  try { options = parseCaptureOptions(args) } catch (reason) { process.stderr.write(`${reason.message}\nUse --help for capture options.\n`); return 2 }
  if (options.help) { process.stdout.write(USAGE); return 0 }
  let cli
  let createViteServer
  try {
    const require = createRequire(import.meta.url)
    cli = require.resolve('@playwright/test/cli')
    const { chromium } = require('@playwright/test')
    const { access } = await import('node:fs/promises')
    await access(chromium.executablePath())
    if (!options.url) createViteServer = (await import('vite')).createServer
  } catch (reason) { process.stderr.write(`Screenshot dependency unavailable: ${reason.message}\nRun npm ci and npx playwright install chromium.\n`); return 3 }
  const startedAt = new Date().toISOString()
  const cancellation = new AbortController()
  const interrupt = () => cancellation.abort()
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)
  let directory
  let server
  let initialManifest
  try {
    const source = sourceIdentity()
    const port = options.url ? undefined : await availablePort()
    const url = options.url ?? `http://127.0.0.1:${port}/`
    directory = await createRunDirectory(options.output, options.label)
    const metadata = join(directory, '.metadata')
    await mkdir(metadata)
    initialManifest = { schemaVersion: 1, label: options.label, startedAt, url, source, status: 'In progress', screens: options.screens, devices: options.devices, captures: [], failures: [] }
    await writeReview(directory, initialManifest)
    if (createViteServer) {
      // Middleware mode avoids Vite's CLI signal handler exiting before review diagnostics are written
      const http = createHttpServer()
      server = { http }
      // Bind Vite's transport to this run's HTTP server so concurrent captures cannot share its fixed middleware port
      const vite = await createViteServer({ root: PROJECT_DIRECTORY, logLevel: 'warn', server: { port, middlewareMode: true, hmr: false, ws: { server: http } } })
      server.vite = vite
      http.on('request', vite.middlewares)
      await new Promise((resolveListen, reject) => { http.once('error', reject); http.listen(port, '127.0.0.1', resolveListen) })
    }
    if (cancellation.signal.aborted) throw new Error('Screenshot capture interrupted')
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(REVIEW_SERVER_TIMEOUT_MS)]) })
    if (!response.ok) throw new Error(`Local review server returned HTTP ${response.status}; check --url`)
    process.stderr.write(`Capturing ${options.screens.join(', ')} on ${options.devices.join(', ')}\nReview directory: ${directory}\n`)
    const environment = { ...process.env, CRYKIT_UI_REVIEW_DIRECTORY: directory, CRYKIT_UI_REVIEW_URL: url,
      CRYKIT_UI_REVIEW_SCREENS: options.screens.join(','), CRYKIT_UI_REVIEW_DEVICES: options.devices.join(','),
    }
    const code = await captureProcess(process.execPath, [cli, 'test', '--config', 'playwright.screenshots.config.ts'], { cwd: PROJECT_DIRECTORY, env: environment }, cancellation.signal)
    const records = await Promise.all((await readdir(metadata)).filter(name => name.endsWith('.json')).sort().map(async name => JSON.parse(await readFile(join(metadata, name), 'utf8'))))
    const failures = records.filter(record => record.error).map(record => ({ device: record.device, screen: record.screen, error: record.error, image: record.image }))
    // Retain successful states even when a later scenario fails so partial reviews stay useful
    for (const device of options.devices) for (const screen of options.screens) if (!records.some(record => record.device === device && record.screen === screen)) failures.push({ device, screen, error: 'Capture did not complete; inspect .artifacts for runner diagnostics' })
    const completedSource = sourceIdentity()
    const manifest = { schemaVersion: 1, label: options.label, startedAt, completedAt: new Date().toISOString(), url, source, completedSource,
      sourceChangedDuringCapture: JSON.stringify(source) !== JSON.stringify(completedSource),
      status: code === 0 && failures.length === 0 ? 'Complete' : 'Incomplete', screens: options.screens, devices: options.devices,
      captures: records.flatMap(record => record.captures ?? []), failures }
    await writeReview(directory, manifest)
    process.stdout.write(`${directory}\n`)
    return manifest.status === 'Complete' ? 0 : 1
  } catch (reason) {
    process.stderr.write(`Screenshot capture failed: ${reason.message}${directory ? `\nPartial output: ${directory}` : ''}\n`)
    if (directory && initialManifest) {
      await writeReview(directory, { ...initialManifest, completedAt: new Date().toISOString(), status: 'Incomplete', failures: [{ device: 'runner', screen: 'startup', error: reason.message }] }).catch(failure => { process.stderr.write(`Could not write capture diagnostics: ${failure.message}\n`) })
      process.stdout.write(`${directory}\n`)
    }
    return 1
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', interrupt)
    if (server) {
      try { await server.vite?.close() }
      finally { await new Promise((resolveClose, reject) => server.http.close(reason => reason && reason.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(reason) : resolveClose())) }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) process.exitCode = await runCapture()
