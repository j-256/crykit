import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { normalizeQualificationConfig, readPrivateConfig, uploadedVersion, verifyVersion, verifyServingVersion, releaseVersion, verifyBundle } from './qualification-release.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const VERSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const DATABASE = '33333333-3333-4333-8333-333333333333'
const testAddress = local => `${local}@${'crykit.lasers.app'}`
const secretNames = ['OPAQUE_SERVER_SETUP', 'SESSION_SECRET', 'CURSOR_SECRET', 'CAPABILITY_SECRET', 'DUMMY_IDENTITY_SECRET', 'EMAIL_STATE_SECRET', 'SERVICE_BACKUP_KEY']
const identity = { version: 1, workerName: 'crykit-qualification', origin: 'https://qualify.crykit.lasers.app', databaseId: DATABASE, limiterNamespaceIds: ['555550001', '555550002', '555550003', '555550004'], adminIssuer: 'https://synthetic.cloudflareaccess.com', adminAudience: 'a'.repeat(64), confirmationAudience: 'b'.repeat(64), excludedDatabaseIds: ['44444444-4444-4444-8444-444444444444'], excludedLimiterNamespaceIds: ['777777001'], excludedAccessAudiences: ['c'.repeat(64)] }
const normalize = c => normalizeQualificationConfig(c, ROOT, identity)
const workerState = () => ({ subdomain: { enabled: false, previews_enabled: false }, logpush: false, observability: { enabled: false, logs: { enabled: false }, traces: { enabled: false } }, tail_consumers: [{ service: 'crykit-qualification-alerts' }] })
async function fixture() {
  const { env, ...base } = JSON.parse(await readFile(join(ROOT, 'wrangler.accounts.example.jsonc'), 'utf8'))
  const c = { ...base, ...env.production, name: 'crykit-qualification', routes: [{ pattern: 'qualify.crykit.lasers.app', custom_domain: true }], tail_consumers: [{ service: 'crykit-qualification-alerts' }] }
  c.vars.SERVICE_ORIGIN = 'https://qualify.crykit.lasers.app'
  c.vars.STORAGE_CAP_BYTES = '134217728'
  c.vars.ADMIN_ACCESS_CONFIG = JSON.stringify({ version: 1, issuer: 'https://synthetic.cloudflareaccess.com', jwksUrl: 'https://synthetic.cloudflareaccess.com/cdn-cgi/access/certs', adminAudience: 'a'.repeat(64), confirmationAudience: 'b'.repeat(64), confirmationEnabled: false })
  c.d1_databases = [{ binding: 'DB', database_name: 'crykit-qualification-metadata', database_id: DATABASE }]
  c.r2_buckets = ['objects', 'backups', 'revocations'].map((suffix, i) => ({ binding: ['OBJECTS', 'LEDGER_BACKUPS', 'REVOCATION_LEDGER'][i], bucket_name: `crykit-qualification-${suffix}` }))
  c.ratelimits.forEach((r, i) => { r.namespace_id = String(555550001 + i) })
  c.send_email = [{ name: 'NATIVE_EMAIL', allowed_sender_addresses: [testAddress('qualification')], allowed_destination_addresses: [testAddress('qualification-test')] }]
  c.vars.EMAIL_FROM = testAddress('qualification')
  c.triggers = { crons: [] }
  return c
}
function version(c) {
  return { id: VERSION, resources: {
    script: { handlers: ['fetch', 'scheduled'] },
    script_runtime: { compatibility_date: c.compatibility_date, limits: c.limits, assets: { raw_run_worker_first: c.assets.run_worker_first } },
    bindings: [
      { name: 'ASSETS', type: 'assets' },
      ...secretNames.map(name => ({ name, type: 'secret_text' })),
      ...Object.entries(c.vars).map(([name, text]) => ({ name, type: 'plain_text', text })),
      ...c.d1_databases.map(({ binding: name, database_id: id }) => ({ name, type: 'd1', id })),
      ...c.r2_buckets.map(({ binding: name, bucket_name }) => ({ name, type: 'r2_bucket', bucket_name })),
      ...c.ratelimits.map(({ name, namespace_id, simple }) => ({ name, type: 'ratelimit', namespace_id, simple })),
      ...c.send_email.map(b => ({ ...b, type: 'send_email' })),
    ],
  } }
}

test('closed qualification keeps the exact entry, secret inventory and resource envelope', async () => {
  const input = await fixture()
  const c = normalize(input)
  assert.equal(c.name, 'crykit-qualification')
  assert.equal(c.main, join(ROOT, 'worker/index.ts'))
  assert.deepEqual(c.secrets.required, secretNames)
  assert.equal(c.vars.ACCOUNTS_ACTIVE, 'false')
  assert.equal(c.build, undefined)
  assert.doesNotThrow(() => verifyVersion(version(c), c, VERSION))
})

test('cross-environment identity, active effects and unsupported executable inputs fail closed', async () => {
  for (const mutate of [
    c => { c.name = 'crykit' }, c => { c.name = 'crykit-preview' },
    c => { c.vars.SERVICE_ORIGIN = 'https://crykit.lasers.app' },
    c => { c.routes[0].pattern = 'preview.crykit.lasers.app' },
    c => { c.d1_databases[0].database_name = 'crykit-production-metadata' },
    c => { c.r2_buckets[0].bucket_name = 'crykit-preview-objects' },
    c => { c.r2_buckets[1].bucket_name = 'crykit-qualification-restore-objects' },
    c => { c.d1_databases[0].database_id = 'not-an-id' },
    c => { c.d1_databases[0].database_id = '44444444-4444-4444-8444-444444444444' },
    c => { c.ratelimits[0].namespace_id = '777777001' },
    c => { c.secrets.required.pop() }, c => { c.vars.SESSION_SECRET = 'private-value' },
    c => { c.workers_dev = true }, c => { c.preview_urls = true },
    c => { c.observability.enabled = true }, c => { c.observability.logs.enabled = true },
    c => { c.limits.cpu_ms = 1001 }, c => { c.vars.STORAGE_CAP_BYTES = '134217729' },
    c => { c.vars.ACCOUNTS_ACTIVE = 'true' }, c => { c.vars.SIGNUP_ACTIVE = 'true' },
    c => { c.vars.EMAIL_SENDING_ACTIVE = 'true' }, c => { c.vars.EMAIL_HEADROOM = 'available' },
    c => { const a = JSON.parse(c.vars.ADMIN_ACCESS_CONFIG); a.confirmationEnabled = true; c.vars.ADMIN_ACCESS_CONFIG = JSON.stringify(a) },
    c => { c.vars.SERVICE_BACKUP_POLICY = '{}' }, c => { c.triggers.crons = ['*/5 * * * *'] },
    c => { c.main = 'worker/testing/local-entry.ts' },
    c => { c.alias.extra = 'worker/testing/local-entry.ts' },
    c => { c.send_email[0].allowed_destination_addresses = ['outside@example.org'] },
    c => { delete c.send_email[0].allowed_destination_addresses },
    c => { c.ratelimits[0].namespace_id = c.ratelimits[1].namespace_id },
    c => { c.env = { production: {} } },
  ]) {
    const c = await fixture(); mutate(c)
    assert.throws(() => normalize(c), e => !e.message.includes('private-value'))
  }
})

test('readback rejects missing secrets, extra bindings and wrong resource identity before assigning traffic', async () => {
  const c = normalize(await fixture())
  for (const mutate of [
    v => { v.id = 'wrong' },
    v => { v.resources.bindings = v.resources.bindings.filter(b => b.name !== 'OPAQUE_SERVER_SETUP') },
    v => { v.resources.bindings.find(b => b.name === 'DB').id = 'wrong' },
    v => { v.resources.bindings.find(b => b.name === 'OBJECTS').bucket_name = 'crykit-production-objects' },
    v => { v.resources.bindings.find(b => b.name === 'NATIVE_EMAIL').allowed_destination_addresses = [testAddress('other')] },
    v => { v.resources.bindings.push({ name: 'LOCAL_IDENTITY', type: 'plain_text', text: 'true' }) },
  ]) { const v = version(c); mutate(v); assert.throws(() => verifyVersion(v, c, VERSION)) }
  const calls = []
  const ops = { worker: async () => workerState(), upload: async () => JSON.stringify({ type: 'version-upload', version: 1, worker_name: c.name, version_id: VERSION }), version: async () => ({ ...version(c), id: 'wrong' }), deploy: async () => { calls.push('deploy') } }
  await assert.rejects(releaseVersion(c, ops)); assert.deepEqual(calls, [])
})

test('ambiguous uploads and uncertain serving assignments never trigger an automatic second deployment', async () => {
  const c = normalize(await fixture())
  const upload = JSON.stringify({ type: 'version-upload', version: 1, worker_name: c.name, version_id: VERSION })
  assert.equal(uploadedVersion(upload), VERSION)
  for (const value of ['', upload + '\n' + upload, upload.replace(c.name, 'crykit')]) assert.throws(() => uploadedVersion(value))
  const calls = []
  const ops = { worker: async () => workerState(), upload: async () => upload, version: async () => version(c), deploy: async () => { calls.push('deploy'); throw Error('private-provider') }, serving: async () => [{ versions: [{ version_id: VERSION, percentage: 100 }] }] }
  assert.equal((await releaseVersion(c, ops)).reconciled, true)
  assert.equal(calls.length, 1)
  ops.serving = async () => []
  await assert.rejects(releaseVersion(c, ops), e => !e.message.includes('private-provider'))
  assert.equal(calls.length, 2)
  assert.throws(() => verifyServingVersion([{ versions: [{ version_id: VERSION, percentage: 50 }] }], VERSION))
})

test('unsafe live ingress and logs prevent account-code upload', async () => {
  const c = normalize(await fixture())
  for (const mutate of [s => { s.subdomain.enabled = true }, s => { delete s.subdomain.previews_enabled }, s => { s.logpush = true }, s => { s.observability.logs.enabled = true }, s => { s.tail_consumers = [] }]) {
    const state = workerState(); mutate(state)
    let uploads = 0
    await assert.rejects(releaseVersion(c, { worker: async () => state, upload: async () => { uploads++ } }))
    assert.equal(uploads, 0)
  }
})

test('post-deployment policy drift fails release without repeating the deployment', async () => {
  const c = normalize(await fixture())
  const calls = []
  let policyReads = 0
  const ops = {
    worker: async () => {
      calls.push('worker')
      const state = workerState()
      if (++policyReads === 2) state.observability.logs.enabled = true
      return state
    },
    upload: async () => { calls.push('upload'); return JSON.stringify({ type: 'version-upload', version: 1, worker_name: c.name, version_id: VERSION }) },
    version: async () => { calls.push('version'); return version(c) },
    deploy: async () => { calls.push('deploy') },
    serving: async () => { calls.push('serving'); return [{ versions: [{ version_id: VERSION, percentage: 100 }] }] },
  }
  await assert.rejects(releaseVersion(c, ops), /producer logging policy is unsafe or unestablished/)
  assert.deepEqual(calls, ['worker', 'upload', 'version', 'deploy', 'serving', 'worker'])
})

test('private input rejects shared modes and symlinks without exposing its values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crykit-qualification-config-'))
  try {
    const path = join(dir, 'config.json')
    await writeFile(path, JSON.stringify(await fixture()), { mode: 0o600 })
    assert.equal((await readPrivateConfig(path)).name, 'crykit-qualification')
    await chmod(path, 0o644); await assert.rejects(readPrivateConfig(path))
    await chmod(path, 0o600); await symlink(path, join(dir, 'alias.json')); await assert.rejects(readPrivateConfig(join(dir, 'alias.json')))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('bundle metadata rejects any fixture entry or fixture import', () => {
  const m = { inputs: { 'worker/index.ts': {} }, outputs: { 'out/index.js': { entryPoint: 'worker/index.ts', exports: ['default'] } } }
  assert.doesNotThrow(() => verifyBundle(m, ROOT, ROOT))
  m.inputs['worker/testing/local-entry.ts'] = {}; assert.throws(() => verifyBundle(m, ROOT, ROOT))
})

test('private build paths resolve from the configuration directory rather than a different checkout', () => {
  const checkout = '/synthetic/checkouts/crykit'
  const configDirectory = '/synthetic/operations/private/release'
  const metadata = entryPoint => ({ inputs: { [entryPoint]: {} }, outputs: { 'bundle/index.js': { entryPoint, exports: ['default'] } } })
  assert.doesNotThrow(() => verifyBundle(metadata('../../../checkouts/crykit/worker/index.ts'), checkout, configDirectory))
  assert.throws(() => verifyBundle(metadata('../../../checkouts/other/worker/index.ts'), checkout, configDirectory), /does not use the production entry/)
  // This path would resolve to the expected entry only if incorrectly based on the checkout
  assert.throws(() => verifyBundle(metadata('../crykit/worker/index.ts'), checkout, configDirectory), /does not use the production entry/)
})

test('CLI supports help and equivalent config options, rejects absent input and conflicting modes', async () => {
  const invoke = args => spawnSync(process.execPath, ['scripts/qualification-release.mjs', ...args], { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH } })
  for (const flag of ['-h', '--help']) { const r = invoke([flag]); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /Usage:/); assert.equal(r.stderr, '') }
  for (const args of [[], ['--deploy'], ['--config='], ['--unknown'], ['--dry-run', '--deploy'], ['--example', '--dry-run']]) { const r = invoke(args); assert.equal(r.status, 2, r.stderr); assert.equal(r.stdout, '') }
  const dir = await mkdtemp(join(tmpdir(), 'crykit-qualification-cli-'))
  try {
    const path = join(dir, 'config.json'); await writeFile(path, JSON.stringify(await fixture()), { mode: 0o600 })
    const identityPath = join(dir, 'identity.json'); await writeFile(identityPath, JSON.stringify(identity), { mode: 0o600 })
    for (const args of [['--config', path], [`--config=${path}`], ['-c' + path], ['-c', path, '--']]) { const r = invoke(['--identity', identityPath, ...args]); assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).worker, 'crykit-qualification'); assert.equal(r.stderr, '') }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('protected identity pins dynamic resources and rejects conflicting baseline inventory', async () => {
  const c = await fixture()
  assert.throws(() => normalizeQualificationConfig(c, ROOT))
  for (const patch of [{ databaseId: '44444444-4444-4444-8444-444444444444' }, { adminAudience: 'c'.repeat(64) }, { limiterNamespaceIds: ['777777001', ...identity.limiterNamespaceIds.slice(1)] }, { excludedDatabaseIds: [] }, { extra: true }]) {
    assert.throws(() => normalizeQualificationConfig(c, ROOT, { ...identity, ...patch }))
  }
})

test('check works without dependencies while packaging reports its missing dependency separately', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crykit-qualification-no-dependencies-'))
  try {
    const checkout = join(directory, 'checkout')
    await mkdir(join(checkout, 'scripts'), { recursive: true })
    const script = join(checkout, 'scripts/qualification-release.mjs')
    await writeFile(script, await readFile(join(ROOT, 'scripts/qualification-release.mjs')))
    const path = join(directory, 'config.json'), identityPath = join(directory, 'identity.json')
    await writeFile(path, JSON.stringify(await fixture()), { mode: 0o600 })
    await writeFile(identityPath, JSON.stringify(identity), { mode: 0o600 })
    const invoke = extra => spawnSync(process.execPath, [script, '-c', path, '-i', identityPath, ...extra], { cwd: checkout, encoding: 'utf8', env: { PATH: process.env.PATH } })
    assert.equal(invoke([]).status, 0)
    const result = invoke(['-n'])
    assert.equal(result.status, 3)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /Pinned dependencies are missing/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('live resource readback requires both qualification database name and UUID plus every exact bucket', async () => {
  const { verifyResources } = await import('./qualification-release.mjs')
  assert.equal(typeof verifyResources, 'function')
  const c = normalize(await fixture())
  const read = async path => path.startsWith('/d1/') ? { name: 'crykit-qualification-metadata', uuid: DATABASE } : { name: path.split('/').at(-1) }
  await verifyResources(c, read)
  for (const bad of [{ name: 'crykit-production-metadata', uuid: DATABASE }, { name: 'crykit-qualification-metadata', uuid: identity.excludedDatabaseIds[0] }]) {
    await assert.rejects(verifyResources(c, async path => path.startsWith('/d1/') ? bad : read(path)))
  }
  await assert.rejects(verifyResources(c, async path => path.startsWith('/d1/') ? read(path) : { name: 'crykit-preview-objects' }))
})
