import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const preparedRootVariable = 'CRYKIT_ACCOUNT_TEST_PREPARED_ROOT'
const bundleNames = ['alerts', 'local', 'opaque-adapter', 'production', 'wasm']

async function runBuild(directory, args = [], extraEnv = {}) {
  return new Promise((resolveRun, reject) => {
    const env = { ...process.env, ...extraEnv }
    const child = spawn(process.execPath, ['scripts/build-account-tests.mjs', ...args], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    child.once('error', reject)
    child.once('close', code => resolveRun({ code, output }))
  })
}

async function withBuildFixture(action) {
  const directory = await mkdtemp(join(tmpdir(), 'crykit-account-build-'))
  try {
    await mkdir(join(directory, 'scripts'))
    await mkdir(join(directory, 'node_modules/wrangler/bin'), { recursive: true })
    await mkdir(join(directory, 'node_modules/@serenity-kit'), { recursive: true })
    await symlink(join(root, 'node_modules/@serenity-kit/opaque'), join(directory, 'node_modules/@serenity-kit/opaque'), 'dir')
    for (const name of ['build-account-tests.mjs', 'opaque-worker-module.mjs']) await cp(join(root, 'scripts', name), join(directory, 'scripts', name))
    // Exercise the actual build orchestrator while retaining real OPAQUE preparation
    // The CLI double checks custom-hook immutability and makes peer draining observable
    await writeFile(join(directory, 'node_modules/wrangler/bin/wrangler.js'), `
const { execFileSync } = require('node:child_process')
const { appendFileSync, mkdirSync, statSync, writeFileSync } = require('node:fs')
const { basename, join } = require('node:path')
const args = process.argv.slice(2)
const BUNDLE_START_TIMEOUT_MS = 5000
const POLL_INTERVAL_MS = 10
const PEER_COMPLETION_DELAY_MS = 250
const SYNTHETIC_FAILURE_EXIT_CODE = 23
const files = ['opaque-runtime.js', 'opaque.wasm', 'OPAQUE-LICENSE']
const stamps = () => files.map(name => statSync(join('.account-tests', name), { bigint: true }).mtimeNs.toString())
if (args[args.indexOf('--config') + 1] === 'wrangler.local.jsonc') {
  const before = stamps()
  execFileSync(process.execPath, ['scripts/build-account-tests.mjs', '--prepare-opaque'], { stdio: 'inherit' })
  if (JSON.stringify(before) !== JSON.stringify(stamps())) throw new Error('A child custom hook rewrote shared prepared files')
}
if (args[0] === 'types') process.exit(0)
const directory = args[args.indexOf('--outdir') + 1]
const name = basename(directory)
const event = phase => appendFileSync('.account-tests/build-events.jsonl', JSON.stringify({ name, phase }) + '\\n')
event('started')
const { readFileSync } = require('node:fs')
const started = Date.now()
const barrier = setInterval(() => {
  const events = readFileSync('.account-tests/build-events.jsonl', 'utf8').trim().split('\\n').map(JSON.parse)
  if (events.filter(event => event.phase === 'started').length < ${bundleNames.length}) {
    if (Date.now() - started > BUNDLE_START_TIMEOUT_MS) throw new Error('Independent bundles did not all start')
    return
  }
  clearInterval(barrier)
  setTimeout(() => {
    event('finished')
    if (name === process.env.CRYKIT_BUILD_FAILURE) process.exit(SYNTHETIC_FAILURE_EXIT_CODE)
    mkdirSync(directory, { recursive: true })
    const main = join(directory, 'main.js')
    writeFileSync(main, 'export default { fetch() {} }')
    writeFileSync(join(directory, 'bundle-meta.json'), JSON.stringify({ outputs: { [main]: { entryPoint: args[1], exports: ['default'] } }, inputs: { [args[1]]: {} } }))
  }, name === process.env.CRYKIT_BUILD_FAILURE ? POLL_INTERVAL_MS : PEER_COMPLETION_DELAY_MS)
}, POLL_INTERVAL_MS)
`)
    await action(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('prepares fresh OPAQUE once before independent bundles and preserves standalone regeneration', async () => {
  await withBuildFixture(async directory => {
    await mkdir(join(directory, '.account-tests'))
    await writeFile(join(directory, '.account-tests/opaque-runtime.js'), 'stale')
    // An inherited child marker must never turn a full invocation into reuse of stale output
    const result = await runBuild(directory, [], { [preparedRootVariable]: directory })
    assert.equal(result.code, 0, result.output)
    const generated = await readFile(join(directory, '.account-tests/opaque-runtime.js'), 'utf8')
    assert.ok(generated.startsWith("import opaqueWasm from './opaque.wasm'"))
    const events = (await readFile(join(directory, '.account-tests/build-events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
    assert.deepEqual(events.filter(event => event.phase === 'finished').map(event => event.name).sort(), bundleNames)
    assert.ok(events.findIndex(event => event.phase === 'finished') > 1, 'Independent bundles must overlap')
    for (const name of bundleNames) {
      const manifest = JSON.parse(await readFile(join(directory, '.account-tests', name, 'manifest.json'), 'utf8'))
      assert.equal(manifest.modules[0].type, 'ESModule')
      assert.ok((await readFile(manifest.modules[0].path)).length > 0)
    }
    await writeFile(join(directory, '.account-tests/opaque-runtime.js'), 'stale')
    const standalone = await runBuild(directory, ['--prepare-opaque'], { [preparedRootVariable]: join(directory, 'other-root') })
    assert.equal(standalone.code, 0, standalone.output)
    assert.equal(await readFile(join(directory, '.account-tests/opaque-runtime.js'), 'utf8'), generated)
  })
})

test('drains every started bundle before reporting a peer failure', async () => {
  await withBuildFixture(async directory => {
    const result = await runBuild(directory, [], { CRYKIT_BUILD_FAILURE: 'production' })
    assert.equal(result.code, 1, result.output)
    assert.match(result.output, /Account bundle production failed/)
    const events = (await readFile(join(directory, '.account-tests/build-events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
    assert.deepEqual(events.filter(event => event.phase === 'started').map(event => event.name).sort(), bundleNames)
    assert.deepEqual(events.filter(event => event.phase === 'finished').map(event => event.name).sort(), bundleNames)
  })
})
