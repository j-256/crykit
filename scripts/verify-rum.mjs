#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { readFile, access, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const root = resolve(import.meta.dirname, '..')
const digest = '637381256384554e1cc3309a62fb238a51b83e7f10b2a56d8ba15dbc73ca762e'
const help = `Usage: node scripts/verify-rum.mjs --beacon FILE [--output DIRECTORY]
Verify the real built app with ordinary Cloudflare RUM and SPA tracking enabled.
All analytics are intercepted locally; unknown browser egress is aborted.
  -b, --beacon FILE       Explicit external beacon.min.js artifact, SHA-256 ${digest}
  -o, --output DIRECTORY  Synthetic receipts and browser diagnostics (default test-results/rum-proof)
  -h, --help              Show this help
Requires npm ci, installed Playwright Chromium, openssl, build:assets,
build:account-tests and vite build --config vite.accounts.config.ts.
The main build must opt in with CRYKIT_RUM_SITE_TOKEN=11111111111111111111111111111111
when running npm run build:assets. Use only this synthetic token for the proof.
No provider credentials or environment variables are required. The script does
not download vendor bytes or build assets. Exit: 0 verified, 1 proof/runtime
failure, 2 invalid usage/artifact/build precondition, 3 missing dependency.
`
let values
try { ({ values } = parseArgs({ options: { help: { type: 'boolean', short: 'h' }, beacon: { type: 'string', short: 'b' }, output: { type: 'string', short: 'o' } }, strict: true, allowPositionals: false })) }
catch { console.error('Invalid RUM verification arguments; use --help'); process.exit(2) }
if (values.help) { console.log(help); process.exit(0) }
if (Object.hasOwn(values, 'output') && !values.output) { console.error('--output requires a nonempty directory'); process.exit(2) }
if (!values.beacon) { console.error('An explicit --beacon artifact is required; use --help'); process.exit(2) }
let artifact
try { artifact = await readFile(resolve(values.beacon)) } catch { console.error('Beacon artifact is unavailable'); process.exit(2) }
if (createHash('sha256').update(artifact).digest('hex') !== digest) { console.error('Beacon artifact digest mismatch'); process.exit(2) }
const inputs = ['dist/index.html', 'dist/_headers', '.account-tests/browser/crypto-proof.html', '.account-tests/local/manifest.json', '.account-tests/production/manifest.json', '.account-tests/wasm/manifest.json', '.account-tests/opaque-adapter/manifest.json']
try { await Promise.all(inputs.map(path => access(resolve(root, path)))) } catch { console.error('Missing immutable app/account build inputs; use --help'); process.exit(2) }
const html = await readFile(resolve(root, 'dist/index.html'), 'utf8')
const attribute = html.match(/data-cf-beacon=(["'])(.*?)\1/s)?.[2]
let configuration
try { configuration = JSON.parse((attribute ?? '').replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&amp;', '&')) } catch { }
if (configuration?.token !== '11111111111111111111111111111111' || configuration?.spa !== true || configuration.send !== undefined) { console.error('Build must use the documented synthetic RUM opt-in token and default SPA-enabled collector; use --help'); process.exit(2) }
let playwright
try { playwright = new URL('cli.js', import.meta.resolve('playwright/package.json')).href } catch { console.error('Missing Playwright dependency; run npm ci'); process.exit(3) }
if (spawnSync('openssl', ['version'], { stdio: 'ignore' }).status !== 0) { console.error('Missing OpenSSL dependency; use --help'); process.exit(3) }
const { chromium } = await import('playwright')
try { await access(chromium.executablePath()) } catch { console.error('Missing Playwright Chromium browser; install the pinned browser'); process.exit(3) }
const output = resolve(values.output ?? resolve(root, 'test-results/rum-proof'))
await mkdir(output, { recursive: true })
const child = spawn(process.execPath, [fileURLToPath(playwright), 'test', '--config', resolve(root, 'scripts/rum-proof/playwright.config.ts')], { cwd: root, stdio: 'inherit', env: { ...process.env, CRYKIT_RUM_BEACON_PATH: resolve(values.beacon), CRYKIT_RUM_OUTPUT: output, CRYKIT_OWN_ACCOUNT_RUNTIME: '1' } })
child.on('error', () => { console.error('Could not start RUM verification'); process.exitCode = 3 })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('close', code => { process.exitCode = code === 0 ? 0 : 1 })
