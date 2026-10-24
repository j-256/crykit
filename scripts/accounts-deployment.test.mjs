import assert from 'node:assert/strict'
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

test('ownerAlertsHaveNoPublicIngressOrCustomerDataBindingsAndStayInactiveWithoutPrivateConfiguration', async () => {
  const config = JSON.parse(await readFile('wrangler.alerts.example.jsonc', 'utf8'))
  assert.equal(config.workers_dev, false)
  assert.equal(config.preview_urls, false)
  assert.equal(config.routes, undefined)
  assert.equal(config.vars.ALERTS_ENABLED, 'false')
  assert.equal(config.vars.DIAGNOSTICS_ENABLED, 'false')
  assert.equal(config.vars.ALERT_EMAIL_TO, '')
  assert.equal(config.d1_databases, undefined)
  assert.equal(config.r2_buckets, undefined)
  assert.equal(config.secrets, undefined)
  assert.equal(config.observability.logs.invocation_logs, false)
  assert.deepEqual(config.durable_objects.bindings, [{ name: 'ALERTS', class_name: 'OwnerAlertState' }])
  assert.deepEqual(config.ratelimits[0].simple, { limit: 1, period: 60 })
})

test('previewCannotUseProductionBindings', async () => {
  const config = JSON.parse(await readFile('wrangler.accounts.example.jsonc', 'utf8'))
  const preview = config.env.preview
  const production = config.env.production
  const local = JSON.parse(await readFile('wrangler.local.jsonc', 'utf8'))
  assert.equal(config.main, 'worker/index.ts')
  assert.equal(config.observability.enabled, false)
  assert.equal(config.observability.logs.enabled, false)
  for (const environment of [preview, production]) {
    assert.notEqual(environment.d1_databases[0].database_id, local.d1_databases[0].database_id)
    assert.equal(environment.vars.ACCOUNTS_ACTIVE, 'false')
    assert.equal(environment.vars.SIGNUP_ACTIVE, 'false')
    assert.equal(environment.vars.EMAIL_SENDING_ACTIVE, 'false')
    assert.equal(environment.vars.EMAIL_HEADROOM, 'unknown')
    assert.deepEqual(environment.triggers.crons, [])
    assert.deepEqual(environment.secrets.required, config.secrets.required)
    assert.equal(environment.r2_buckets.length, 3)
    assert.equal(new Set(environment.r2_buckets.map(bucket => bucket.bucket_name)).size, 3)
    assert.equal(environment.vars.EMAIL_FROM, environment.send_email[0].allowed_sender_addresses[0])
    const access = JSON.parse(environment.vars.ADMIN_ACCESS_CONFIG)
    assert.equal(access.confirmationEnabled, false)
    assert.notEqual(access.adminAudience, access.confirmationAudience)
  }
  const identities = environment => [environment.name, environment.vars.SERVICE_ORIGIN, environment.d1_databases[0].database_id, ...environment.r2_buckets.map(bucket => bucket.bucket_name), environment.vars.EMAIL_FROM]
  assert.ok(identities(preview).every(identity => !identities(production).includes(identity)))
  assert.equal(preview.vars.STORAGE_CAP_BYTES, '68719476736')
  assert.ok(config.secrets.required.includes('OPAQUE_SERVER_SETUP'))
  assert.ok(config.secrets.required.includes('SERVICE_BACKUP_KEY'))
  const deployed = JSON.parse(await readFile('wrangler.jsonc', 'utf8'))
  assert.equal(deployed.main, undefined)
  const prepared = JSON.parse(await readFile('wrangler.preview.jsonc', 'utf8'))
  assert.equal(prepared.main, config.main)
  assert.notEqual(prepared.name, deployed.name)
  assert.equal(prepared.vars.SERVICE_ORIGIN, preview.vars.SERVICE_ORIGIN)
  assert.equal(prepared.vars.STORAGE_CAP_BYTES, preview.vars.STORAGE_CAP_BYTES)
  assert.notEqual(prepared.d1_databases[0].database_id, local.d1_databases[0].database_id)
  assert.notEqual(prepared.d1_databases[0].database_id, production.d1_databases[0].database_id)
  assert.equal(new Set(prepared.r2_buckets.map(bucket => bucket.bucket_name)).size, prepared.r2_buckets.length)
  assert.ok(prepared.r2_buckets.every(bucket => !production.r2_buckets.some(other => other.bucket_name === bucket.bucket_name)))
  for (const gate of ['ACCOUNTS_ACTIVE', 'SIGNUP_ACTIVE', 'EMAIL_SENDING_ACTIVE']) assert.equal(prepared.vars[gate], 'false')
  assert.equal(prepared.vars.EMAIL_HEADROOM, 'unknown')
  assert.deepEqual(prepared.triggers.crons, [])
  assert.deepEqual(prepared.secrets.required, config.secrets.required)
  assert.deepEqual(prepared.assets.run_worker_first, ['/api/*', '/admin', '/admin/*'])
  assert.equal(prepared.observability.logs.enabled, false)
  assert.equal(prepared.observability.logs.invocation_logs, false)
})

test('buildNeverPublishesPrivateFixturesOrUnsafeCacheRoutes: asset validator rejects private build inputs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crykit-assets-contract-'))
  const script = new URL('./check-assets.mjs', import.meta.url).pathname
  const check = () => spawnSync(process.execPath, [script], { cwd: directory, encoding: 'utf8' })
  try {
    await mkdir(join(directory, 'dist'))
    await writeFile(join(directory, 'dist/index.html'), '<!doctype html><title>Synthetic</title>')
    assert.equal(check().status, 0)
    for (const path of ['.dev.vars', '.account-tests/fixture.js', '__accounts-proof/index.html', 'private/fixture.json', 'worker/testing/local-entry.js', 'assets/private.js.map', 'backup.sqlite', 'crykit-service-secrets.json', 'assets/crykit-service-secrets.json', 'preview-service-secrets.json', 'assets/preview-service-secrets.json', 'assets/preview-service-secrets.json.backup']) {
      const destination = join(directory, 'dist', path)
      await mkdir(join(destination, '..'), { recursive: true })
      await writeFile(destination, 'synthetic private fixture')
      const result = check()
      assert.equal(result.status, 1, path)
      assert.match(result.stderr, /Private|private|fixture|map/)
      await rm(join(directory, 'dist'), { recursive: true, force: true })
      await mkdir(join(directory, 'dist'))
      await writeFile(join(directory, 'dist/index.html'), '<!doctype html><title>Synthetic</title>')
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('privacy allows the public contact while rejecting adjacent and similar private addresses', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crykit-contact-contract-'))
  const script = new URL('./privacy-check.mjs', import.meta.url).pathname
  const git = args => {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  const publicContact = 'abuse@crykit.lasers.app'
  const manifests = [
    ['mod-artwork.json', { atlases: {}, assets: {} }],
    ['wiki-sprites.json', { assets: {} }],
    ['mod-sprites.json', { assets: {} }],
    ['game-assets.json', { assets: {} }],
    ['world-map.json', { layers: [] }],
  ]
  try {
    git(['init', '--quiet'])
    await mkdir(join(directory, 'src/catalog'), { recursive: true })
    for (const [name, contents] of manifests) await writeFile(join(directory, 'src/catalog', name), JSON.stringify(contents))
    git(['add', ...manifests.map(([name]) => `src/catalog/${name}`)])
    for (const [contents, status] of [
      [`Contact [${publicContact}](mailto:${publicContact}).`, 0],
      [`${publicContact} private@` + 'invalid.test', 1],
      [`private-${publicContact}`, 1],
      [`${publicContact}.invalid`, 1],
      ['support@' + 'crykit.lasers.app', 1],
      [publicContact.replace('@', '+other@'), 1],
    ]) {
      await writeFile(join(directory, 'contact.md'), contents)
      git(['add', 'contact.md'])
      for (const args of [[], ['--staged']]) {
        const result = spawnSync(process.execPath, [script, ...args], { cwd: directory, encoding: 'utf8' })
        assert.equal(result.status, status, result.stderr)
        if (status) assert.match(result.stderr, /contact\.md: personal email/)
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
