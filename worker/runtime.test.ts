import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { z } from 'zod'
import { afterEach, describe, expect, it } from 'vitest'
import { CommitRequestSchema, maxAuthJsonBytes } from '../src/account/protocol'
import { createServiceFixture, type ServiceFixture } from './testing/service-fixture'
import { probeJson } from './testing/probe-client'
import { readJson } from './http'
import { createServiceContext, requireServiceBindings, type SafeEvent } from './context'

const parseCommit = CommitRequestSchema.safeParse
const fixtures: ServiceFixture[] = []
async function fixture(options: Parameters<typeof createServiceFixture>[0] = {}) {
  const f = await createServiceFixture({ ...options, runtimeProbes: true })
  fixtures.push(f)
  return f
}
afterEach(async () => { await Promise.all(fixtures.splice(0).map(f => f.dispose())) })

describe('isolated account runtime', () => {
  it('requires explicit runtime probes before testing their response status', async () => {
    const f = await createServiceFixture()
    fixtures.push(f)
    for (const path of ['/__accounts/production/identity', '/__accounts/probe/wasm', '/__accounts/probe/opaque-adapter', 'http://127.0.0.1/__accounts/production/email']) {
      await expect(f.request(path)).rejects.toThrow('runtimeProbes')
    }
    expect((await f.request('/api/v1/service')).status).toBe(200)
  })

  it('keepsGuestAssetsWhenAccountsAreInactive', async () => {
    const f = await fixture({ active: false })
    expect((await f.request('/api/v1/service')).status).toBe(200)
    expect(await (await f.request('/api/v1/service')).json()).toMatchObject({ accountsAvailable: false, signupAvailable: false })
    expect((await f.request('/')).status).toBe(200)
    expect((await f.request('/api/v1/account')).status).toBe(503)
  })

  it('rejectsUnknownProtocolFieldsAndOversizedBodies', async () => {
    const f = await fixture()
    expect(parseCommit({ version: 1, password: 'forbidden' }).success).toBe(false)
    expect(maxAuthJsonBytes).toBe(64 * 1024)
    for (const body of ['{"version":1,"password":"forbidden"}', '{', JSON.stringify({ value: 'x'.repeat(64 * 1024) })]) {
      const response = await f.request('/__accounts/probe/json', { method: 'POST', headers: { 'content-type': 'application/json' }, body })
      expect(response.status).toBe(body.length > 64 * 1024 ? 413 : 400)
      expect(await response.json()).toMatchObject({ error: { code: body.length > 64 * 1024 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_REQUEST', requestId: expect.any(String) } })
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
    const accepted = await f.request('/__accounts/probe/json', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"version":1}' })
    expect(accepted.status).toBe(200)
  })

  it('rejectsLocalIdentityInProductionEntry', async () => {
    const f = await fixture({ localIdentity: true })
    const productionIdentityResponse = await f.request('/api/v1/account', { headers: { 'x-crykit-local-identity': 'synthetic-account' } })
    expect(productionIdentityResponse.status).toBe(401)
    expect((await f.request('/__accounts/production/identity', { method: 'POST' })).status).toBe(401)
  })

  it('failsClosedWhenActivationBindingsAreMissing', () => {
    expect(() => requireServiceBindings({ ACCOUNTS_ACTIVE: 'true' })).toThrow()
  })

  it('missingSecretNeverGeneratesNewSetup', async () => {
    const f = await fixture({ production: true, opaqueSetup: '' })
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await (await f.request('/api/v1/service')).json()).toMatchObject({ accountsAvailable: false, signupAvailable: false })
      expect((await f.request('/')).status).toBe(200)
      expect((await f.request('/api/v1/account')).status).toBe(503)
    }
    expect(await f.db.prepare('SELECT COUNT(*) AS count FROM accounts').first('count')).toBe(0)
    const metadata = JSON.parse(await readFile('.account-tests/production/bundle-meta.json', 'utf8')) as { inputs: Record<string, unknown> }
    // Inspect authored deployed inputs, not the dependency's unused setup export
    const sources = await Promise.all(Object.keys(metadata.inputs).filter(path => path.startsWith('worker/')).map(path => readFile(path, 'utf8')))
    expect(sources.length).toBeGreaterThan(0)
    expect(sources.filter(source => /\.createSetup\s*\(/.test(source))).toEqual([])
  })

  it('usesRealLocalD1AndSeparatePrivateR2Buckets', async () => {
    const f = await fixture()
    await f.db.exec('CREATE TABLE fixture_probe (value TEXT)')
    await f.db.prepare('INSERT INTO fixture_probe VALUES (?)').bind('synthetic').run()
    expect(await f.db.prepare('SELECT value FROM fixture_probe').first('value')).toBe('synthetic')
    await f.objects.put('synthetic', 'ciphertext-only')
    expect(await (await f.objects.get('synthetic'))?.text()).toBe('ciphertext-only')
    expect((await f.request('/synthetic')).status).toBe(404)
    expect(await (await f.request('/__accounts/probe/ledger')).json()).toEqual({ keys: [] })
    await f.revocations.put('opaque-fixture-probe', 'retained')
    expect(await f.objects.get('opaque-fixture-probe')).toBeNull()
    expect(await (await f.request('/__accounts/probe/ledger')).json()).toEqual({ keys: [] })
    expect(await (await f.request('/api/v1/service')).json()).toMatchObject({ accountsAvailable: true })
    const independent = await fixture()
    expect(await independent.objects.get('synthetic')).toBeNull()
  })

  it('controlsClockFaultsAndCapturesOnlyLocalEventsAndEmail', async () => {
    const f = await fixture({ now: 1000 })
    f.advance(250)
    expect(await (await f.request('/__accounts/probe/clock')).json()).toEqual({ now: 1250 })
    f.failNext('probe')
    expect((await f.request('/__accounts/probe/fault')).status).toBe(503)
    expect((await f.request('/__accounts/probe/fault')).status).toBe(200)
    const events = await f.events()
    expect(events).toContainEqual(expect.objectContaining({ operation: 'probe', stage: 'probe', code: 'SERVICE_UNAVAILABLE' }))
    const measurement = await (await f.request('/__accounts/probe/measurement')).json() as { events: number; eventBytes: number; eventGroups: Record<string, number> }
    expect(measurement.events).toBe(events.length)
    expect(measurement.eventBytes).toBe(events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0))
    expect(Object.values(measurement.eventGroups).reduce((sum, count) => sum + count, 0)).toBe(events.length)
    const independent = await fixture({ now: 9000 })
    expect(await independent.events()).toEqual([])
    expect(await (await independent.request('/__accounts/probe/clock')).json()).toEqual({ now: 9000 })
    await f.request('/__accounts/probe/email', { method: 'POST' })
    expect(await f.emails()).toEqual([expect.objectContaining({ recipient: 'synthetic@example.org', kind: 'verify-account' })])
    await f.runJobs()
  })

  it('boundsStreamedBytesWithoutTrustingContentLength', async () => {
    const f = await fixture()
    const exact = ' '.repeat(65523) + '{"version":1}'
    expect((await f.request('/__accounts/probe/json', { method: 'POST', headers: { 'content-type': 'application/json' }, body: exact })).status).toBe(200)
    expect((await f.request('/__accounts/probe/json', { method: 'POST', headers: { 'content-type': 'application/json' }, body: exact + ' ' })).status).toBe(413)
    const schema = z.strictObject({ value: z.string() })
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{"value":"12345"}')); controller.close() } })
    const request = new Request('http://127.0.0.1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit)
    await expect(readJson(request, schema, 16)).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' })
    const invalidLength = new Request('http://127.0.0.1', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '-1' }, body: '{}' })
    await expect(readJson(invalidLength, schema, 16)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('returnsVersionAndEncodingErrorsWithoutRawInput', async () => {
    const f = await fixture()
    const version = await f.request('/__accounts/probe/json', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"version":2,"password":"private-test-value"}' })
    expect(version.status).toBe(426)
    expect(await version.json()).toEqual({ error: { code: 'UNSUPPORTED_VERSION', requestId: expect.any(String) } })
    const badUtf8 = await f.request('/__accounts/probe/json', { method: 'POST', headers: { 'content-type': 'application/json' }, body: new Uint8Array([0xff]) })
    expect(badUtf8.status).toBe(400)
    expect(await badUtf8.text()).not.toContain('private-test-value')
  })

  it('keepsFixtureModulesOutOfProductionManifest', async () => {
    for (const name of ['local', 'production']) {
      const manifest = JSON.parse(await readFile(`.account-tests/${name}/manifest.json`, 'utf8')) as { entryPoint: string; modules: { path: string; type: string }[]; inputs: string[] }
      const metadata = JSON.parse(await readFile(`.account-tests/${name}/bundle-meta.json`, 'utf8')) as { outputs: Record<string, { entryPoint?: string }> }
      const main = Object.entries(metadata.outputs).find(([, output]) => output.entryPoint)?.[0]
      expect(manifest.modules[0]).toEqual({ path: resolve(main!), type: 'ESModule' })
      for (const module of manifest.modules) expect((await readFile(module.path)).byteLength).toBeGreaterThan(0)
      if (name === 'production') expect(manifest.inputs.filter(input => input.includes('worker/testing/') || input.includes('src/account/crypto/'))).toEqual([])
    }
  })

  it('stripsUnboundedAndPrivateTelemetryFields', () => {
    const events: SafeEvent[] = []
    const context = createServiceContext(new Request('http://127.0.0.1/private?secret=hidden'), {}, { now: () => 42, emit: event => { events.push(event) }, fail() {} })
    context.emit({ operation: 'x'.repeat(200), bytes: -1, durationMs: Infinity, rowsRead: 4, body: 'secret', url: 'private' } as unknown as SafeEvent)
    expect(events).toEqual([{ operation: 'x'.repeat(128), rowsRead: 4 }])
    expect(context.now()).toBe(42)
  })

  it('attachesOnlyAuthoredRouteTemplatesToFailureDiagnostics', () => {
    const events: SafeEvent[] = []
    const request = new Request('https://example.test/api/public/v1/shares/synthetic-private?capability=synthetic-private')
    const context = createServiceContext(request, {}, { now: () => 42, emit: event => { events.push(event) } })
    context.emit({ operation: 'shares', stage: 'route', code: 'RATE_LIMITED', route: request.url, method: 'synthetic-private', retryAfterSeconds: 60 } as unknown as SafeEvent)
    expect(events).toEqual([{ operation: 'shares', stage: 'route', code: 'RATE_LIMITED', route: '/api/public/v1/shares/:shareId', method: 'GET', retryAfterSeconds: 60 }])
    expect(JSON.stringify(events)).not.toContain('synthetic-private')
  })


  it('consumesOneFaultAcrossConcurrentRequests', async () => {
    const f = await fixture()
    f.failNext('probe')
    const responses = await Promise.all([f.request('/__accounts/probe/fault'), f.request('/__accounts/probe/fault')])
    expect(responses.map(response => response.status).sort()).toEqual([200, 503])
  })


  it('loadsWranglerCollectedWasmFromEmittedManifest', async () => {
    const f = await fixture()
    const response = await f.request('/__accounts/probe/wasm')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ answer: 42 })
    const manifest = JSON.parse(await readFile('.account-tests/wasm/manifest.json', 'utf8')) as { modules: { type: string }[] }
    expect(manifest.modules.filter(module => module.type === 'CompiledWasm')).toHaveLength(1)
  })


  it('emitsBoundedCheckpointTimingBeforeAnInjectedFault', () => {
    const events: SafeEvent[] = []
    let now = 100
    const context = createServiceContext(new Request('http://127.0.0.1'), {}, { now: () => now, emit: event => { events.push(event) }, fail(stage) { if (stage === 'commit.before-batch') throw new Error('synthetic-fault') } })
    now = 125
    expect(() => context.checkpoint('commit.before-batch')).toThrow('synthetic-fault')
    expect(events).toEqual([{ operation: 'checkpoint', stage: 'commit.before-batch', durationMs: 25 }])
    expect(() => context.checkpoint('private@example.org')).toThrow()
    expect(events).toHaveLength(1)
  })


  it('rejectsProbeUrlsOutsideLoopbackBeforeAnyRequest', async () => {
    const schema = z.strictObject({ now: z.number() })
    await expect(probeJson('https://example.invalid', '/__accounts/probe/clock', schema)).rejects.toThrow('loopback')
    await expect(probeJson('http://127.0.0.1', 'https://example.invalid/override', schema)).rejects.toThrow('loopback')
  })

  it('rejectsProbeRedirectsEvenWhenCallersRequestFollowing', async () => {
    const receivedBodies: string[] = []
    const server = createServer(async (request, response) => {
      if (request.url === '/redirect') {
        response.writeHead(307, { location: `http://[::ffff:127.0.0.1]:${port}/destination` })
        response.end()
      } else {
        let body = ''
        for await (const chunk of request) body += chunk.toString()
        receivedBodies.push(body)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{"now":42}')
      }
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected loopback TCP server')
    const port = address.port
    try {
      await expect(probeJson(`http://127.0.0.1:${port}`, '/redirect', z.strictObject({ now: z.number() }), { method: 'POST', body: 'synthetic-body', redirect: 'follow' })).rejects.toThrow()
      expect(receivedBodies).toEqual([])
      expect(await probeJson(`http://127.0.0.1:${port}`, '/destination', z.strictObject({ now: z.number() }))).toEqual({ now: 42 })
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })


  it('preservesSizeErrorsWhenStreamCancellationFails', async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(17)) }, cancel() { throw new Error('synthetic cancellation failure') } })
    const request = new Request('http://127.0.0.1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit)
    await expect(readJson(request, z.strictObject({}), 16)).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' })
  })

})
