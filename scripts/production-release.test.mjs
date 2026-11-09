import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, chmod, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { normalizeProductionConfig, readPrivateConfig, uploadedVersion, verifyVersion, verifyServingVersion, releaseVersion } from './production-release.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const VERSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const DATABASE = '33333333-3333-4333-8333-333333333333'
const SECRET_NAMES = ['OPAQUE_SERVER_SETUP', 'SESSION_SECRET', 'CURSOR_SECRET', 'CAPABILITY_SECRET', 'DUMMY_IDENTITY_SECRET', 'EMAIL_STATE_SECRET', 'SERVICE_BACKUP_KEY']
const workerState = () => ({ subdomain: { enabled: false, previews_enabled: false }, logpush: false, observability: { enabled: false, logs: { enabled: false, invocation_logs: false }, traces: { enabled: false } }, tail_consumers: [{ service: 'crykit-alerts' }] })

async function fixture() {
  const example = JSON.parse(await readFile(join(ROOT, 'wrangler.accounts.example.jsonc'), 'utf8'))
  const { env, ...base } = example
  const config = { ...base, ...env.production, name: 'crykit', routes: [{ pattern: 'crykit.lasers.app', custom_domain: true }], tail_consumers: [{ service: 'crykit-alerts' }] }
  config.d1_databases[0] = { binding: 'DB', database_name: 'crykit-production-metadata', database_id: DATABASE, migrations_dir: 'worker/migrations' }
  config.r2_buckets = [{ binding: 'OBJECTS', bucket_name: 'crykit-production-objects' }, { binding: 'LEDGER_BACKUPS', bucket_name: 'crykit-production-backups' }, { binding: 'REVOCATION_LEDGER', bucket_name: 'crykit-production-revocations' }]
  config.vars.ADMIN_ACCESS_CONFIG = JSON.stringify({ version: 1, issuer: 'https://synthetic.cloudflareaccess.com', jwksUrl: 'https://synthetic.cloudflareaccess.com/cdn-cgi/access/certs', adminAudience: 'a'.repeat(64), confirmationAudience: 'b'.repeat(64), confirmationEnabled: false })
  return config
}

function version(config) {
  return {
    id: VERSION,
    metadata: { has_preview: false },
    resources: {
      script: { handlers: ['fetch', 'scheduled'] },
      script_runtime: { compatibility_date: '2026-09-28', limits: { cpu_ms: 1000 }, assets: { raw_run_worker_first: ['/api/*', '/admin', '/admin/*'] } },
      bindings: [
        { name: 'ASSETS', type: 'assets' },
        { name: 'DB', type: 'd1', id: DATABASE, database_id: DATABASE },
        { name: 'OBJECTS', type: 'r2_bucket', bucket_name: 'crykit-production-objects' },
        { name: 'LEDGER_BACKUPS', type: 'r2_bucket', bucket_name: 'crykit-production-backups' },
        { name: 'REVOCATION_LEDGER', type: 'r2_bucket', bucket_name: 'crykit-production-revocations' },
        { name: 'NATIVE_EMAIL', type: 'send_email', allowed_sender_addresses: ['production-sender@example.org'] },
        ...SECRET_NAMES.map(name => ({ name, type: 'secret_text' })),
        ...Object.entries(config.vars).map(([name, text]) => ({ name, type: 'plain_text', text })),
        ...config.ratelimits.map(({ name, namespace_id, simple }) => ({ name, type: 'ratelimit', namespace_id, simple })),
      ],
    },
  }
}

test('private configuration keeps production identity while build paths belong to the reviewed checkout', async () => {
  const input = await fixture()
  input.main = '/operator/source/worker/index.ts'
  input.build.command = 'untrusted build command'
  input.alias['@serenity-kit/opaque'] = '/operator/opaque-runtime.js'
  input.assets.directory = '/operator/dist'
  const config = normalizeProductionConfig(input, ROOT)
  assert.equal(config.main, join(ROOT, 'worker/index.ts'))
  assert.equal(config.assets.directory, join(ROOT, 'dist'))
  assert.equal(config.alias['@serenity-kit/opaque'], join(ROOT, '.account-tests/opaque-runtime.js'))
  assert.equal(config.build, undefined)
  assert.equal(config.d1_databases[0].database_id, DATABASE)
  assert.equal(config.vars.ACCOUNTS_ACTIVE, 'false')
  assert.deepEqual(config.secrets.required, SECRET_NAMES)
})

test('missing, cross-environment and executable configuration cannot become a production release', async () => {
  for (const mutate of [
    c => { c.name = 'crykit-preview' },
    c => { c.vars.SERVICE_ORIGIN = 'https://preview.crykit.lasers.app' },
    c => { c.d1_databases[0].database_name = 'crykit-preview-metadata' },
    c => { c.r2_buckets[0].bucket_name = 'crykit-preview-objects' },
    c => { c.r2_buckets[1].bucket_name = c.r2_buckets[0].bucket_name },
    c => { c.secrets.required.pop() },
    c => { c.vars.SESSION_SECRET = 'must-never-appear-in-diagnostics' },
    c => { c.workers_dev = true },
    c => { c.preview_urls = true },
    c => { c.assets.run_worker_first = [] },
    c => { c.unsafe = { bindings: [] } },
    c => { c.env = { production: {} } },
    c => { c.vars.ADMIN_ACCESS_CONFIG = '{private malformed value' },
  ]) {
    const config = await fixture()
    mutate(config)
    assert.throws(() => normalizeProductionConfig(config, ROOT), error => !/must-never|private malformed/.test(error.message))
  }
  assert.throws(() => normalizeProductionConfig(undefined, ROOT))
})

test('private configuration files require ownership, restrictive modes and no symlink', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crykit-release-file-'))
  try {
    const file = join(dir, 'production.json')
    await writeFile(file, JSON.stringify(await fixture()), { mode: 0o600 })
    assert.equal((await readPrivateConfig(file)).name, 'crykit')
    await chmod(file, 0o644)
    await assert.rejects(readPrivateConfig(file))
    await chmod(file, 0o600)
    await symlink(file, join(dir, 'link.json'))
    await assert.rejects(readPrivateConfig(join(dir, 'link.json')))
    await writeFile(file, '{private malformed value')
    await assert.rejects(readPrivateConfig(file), error => !error.message.includes('private malformed'))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('only one structured upload for the production Worker can select a version', () => {
  const valid = JSON.stringify({ type: 'version-upload', version: 1, worker_name: 'crykit', version_id: VERSION })
  assert.equal(uploadedVersion(valid), VERSION)
  for (const input of ['', '{}', 'private malformed output', valid + '\n' + valid, valid.replace('crykit', 'crykit-preview'), valid.replace(VERSION, 'latest')]) assert.throws(() => uploadedVersion(input))
})

test('uploaded metadata must retain secrets, resources, gates and protected routing before traffic changes', async () => {
  const config = normalizeProductionConfig(await fixture(), ROOT)
  assert.doesNotThrow(() => verifyVersion(version(config), config, VERSION))
  for (const mutate of [
    v => { v.id = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
    v => { v.resources.script.handlers = [] },
    v => { v.resources.bindings = v.resources.bindings.filter(b => b.name !== 'SESSION_SECRET') },
    v => { v.resources.bindings.find(b => b.name === 'DB').id = 'wrong-database' },
    v => { v.resources.bindings.find(b => b.name === 'OBJECTS').bucket_name = 'crykit-preview-objects' },
    v => { v.resources.bindings.find(b => b.name === 'ACCOUNTS_ACTIVE').text = 'true' },
    v => { v.resources.bindings.find(b => b.name === 'NATIVE_EMAIL').allowed_sender_addresses = ['foreign@example.org'] },
    v => { v.resources.bindings.push({ name: 'PRIVATE_EXTRA', type: 'plain_text', text: 'private-value' }) },
    v => { v.resources.script_runtime.assets.raw_run_worker_first = [] },
    v => { v.resources.script_runtime.limits.cpu_ms = 10 },
  ]) {
    const data = version(config)
    mutate(data)
    assert.throws(() => verifyVersion(data, config, VERSION), error => !error.message.includes('private-value'))
  }
})

test('serving readback requires the exact uploaded version at full traffic', () => {
  assert.doesNotThrow(() => verifyServingVersion([{ versions: [{ version_id: VERSION, percentage: 100 }] }], VERSION))
  for (const data of [[], [{ versions: [{ version_id: VERSION, percentage: 50 }] }], [{ versions: [{ version_id: 'different', percentage: 100 }] }]]) assert.throws(() => verifyServingVersion(data, VERSION))
})

test('a mismatched uploaded version prevents deployment and an uncertain deploy is read back without retry', async () => {
  const config = normalizeProductionConfig(await fixture(), ROOT)
  const commands = []
  const operations = {
    upload: async () => JSON.stringify({ type: 'version-upload', version: 1, worker_name: 'crykit', version_id: VERSION }),
    version: async () => ({ ...version(config), id: 'wrong' }),
    deploy: async id => { commands.push(id) },
    serving: async () => [{ versions: [{ version_id: VERSION, percentage: 100 }] }],
    worker: async () => workerState(),
  }
  await assert.rejects(releaseVersion(config, operations))
  assert.deepEqual(commands, [])
  operations.version = async () => version(config)
  operations.deploy = async id => { commands.push(id); throw new Error('private provider response') }
  assert.equal((await releaseVersion(config, operations)).versionId, VERSION)
  assert.deepEqual(commands, [VERSION])
  operations.serving = async () => [{ versions: [{ version_id: 'different', percentage: 100 }] }]
  await assert.rejects(releaseVersion(config, operations), error => !error.message.includes('private provider response'))
  assert.equal(commands.length, 2)
})

test('producer persistence is rejected before publication', async () => {
  for (const mutate of [
    c => { c.observability.enabled = true },
    c => { c.observability.logs.enabled = true },
    c => { c.observability.logs.invocation_logs = true },
    c => { c.observability.traces = { enabled: true } },
    c => { delete c.observability },
  ]) {
    const input = await fixture()
    mutate(input)
    assert.throws(() => normalizeProductionConfig(input, ROOT))
  }
})

test('non-default R2 jurisdictions cannot bypass exact resource identity', async () => {
  const input = await fixture()
  input.r2_buckets[0].jurisdiction = 'eu'
  assert.throws(() => normalizeProductionConfig(input, ROOT))
  const config = normalizeProductionConfig(await fixture(), ROOT)
  const data = version(config)
  data.resources.bindings.find(binding => binding.name === 'OBJECTS').jurisdiction = 'fedramp'
  assert.throws(() => verifyVersion(data, config, VERSION))
})

test('live privacy, ingress and alert policy are established before upload and rechecked after uncertain deploy', async () => {
  const config = normalizeProductionConfig(await fixture(), ROOT)
  const mutations = [
    s => { s.subdomain.enabled = true },
    s => { s.subdomain.previews_enabled = true },
    s => { delete s.subdomain.previews_enabled },
    s => { s.observability.enabled = true },
    s => { s.observability.logs.enabled = true },
    s => { s.observability.traces.enabled = true },
    s => { delete s.observability },
    s => { s.logpush = true },
    s => { s.tail_consumers = [] },
  ]
  for (const mutate of mutations) {
    const calls = []
    let state = workerState()
    mutate(state)
    const operations = {
      worker: async () => state,
      upload: async () => { calls.push('upload'); return JSON.stringify({ type: 'version-upload', version: 1, worker_name: 'crykit', version_id: VERSION }) },
      version: async () => version(config),
      deploy: async () => { calls.push('deploy'); state = workerState(); mutate(state); throw new Error('private provider response') },
      serving: async () => [{ versions: [{ version_id: VERSION, percentage: 100 }] }],
    }
    await assert.rejects(releaseVersion(config, operations))
    assert.deepEqual(calls, [])
    state = workerState()
    await assert.rejects(releaseVersion(config, operations))
    assert.deepEqual(calls, ['upload', 'deploy'])
  }
})

test('Worker readback accepts dormant log defaults and the provider Tail name alias while gates are disabled', async () => {
  const { verifyWorkerState } = await import('./production-release.mjs')
  const state = workerState()
  state.observability.logs.invocation_logs = true
  state.observability.logs.persist = true
  state.observability.traces.persist = true
  state.tail_consumers[0].name = 'crykit-alerts'
  const config = normalizeProductionConfig(await fixture(), ROOT)
  assert.doesNotThrow(() => verifyWorkerState(state, config))
})

test('CLI help is credential-free and invalid or missing configuration never falls back to static deployment', () => {
  const invoke = args => spawnSync(process.execPath, ['scripts/production-release.mjs', ...args], { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH } })
  for (const flag of ['-h', '--help']) {
    const result = invoke([flag])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Usage:/)
    assert.equal(result.stderr, '')
  }
  for (const args of [[], ['--deploy'], ['--config='], ['--unknown'], ['--example', '--deploy'], ['--dry-run', '--deploy']]) {
    const result = invoke(args)
    assert.equal(result.status, 2, JSON.stringify({ args, stderr: result.stderr }))
    assert.equal(result.stdout, '')
  }
})

test('a parent-directory alias cannot hide private configuration inside source inputs', async () => {
  await mkdir(join(ROOT, '.account-tests'), { recursive: true })
  const inside = await mkdtemp(join(ROOT, '.account-tests/release-config-'))
  const outside = await mkdtemp(join(tmpdir(), 'crykit-release-alias-'))
  try {
    await writeFile(join(inside, 'config.json'), JSON.stringify(await fixture()), { mode: 0o600 })
    await symlink(inside, join(outside, 'alias'))
    const result = spawnSync(process.execPath, ['scripts/production-release.mjs', '--config', join(outside, 'alias/config.json')], { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH } })
    assert.equal(result.status, 2, result.stdout)
  } finally {
    await rm(inside, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('release packaging refuses a testing entry or fixture import in the actual bundle metadata', async () => {
  const { verifyBundle } = await import('./production-release.mjs')
  assert.equal(typeof verifyBundle, 'function')
  const metadata = { inputs: { 'worker/index.ts': {}, '.account-tests/opaque-runtime.js': {} }, outputs: { 'bundle/index.js': { entryPoint: 'worker/index.ts', exports: ['default'] } } }
  assert.doesNotThrow(() => verifyBundle(metadata, ROOT))
  const fixtureImport = structuredClone(metadata)
  fixtureImport.inputs['worker/testing/local-entry.ts'] = {}
  assert.throws(() => verifyBundle(fixtureImport, ROOT))
  const fixtureEntry = structuredClone(metadata)
  fixtureEntry.outputs['bundle/index.js'].entryPoint = 'worker/testing/local-entry.ts'
  assert.throws(() => verifyBundle(fixtureEntry, ROOT))
  assert.throws(() => verifyBundle({ inputs: {}, outputs: {} }, ROOT))
})
