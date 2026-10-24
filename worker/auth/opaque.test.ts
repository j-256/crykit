import { afterEach, expect, it } from 'vitest'
import * as library from '@serenity-kit/opaque'
import { createServiceFixture, type ServiceFixture } from '../testing/service-fixture'
import * as client from '../../src/account/crypto/opaque'
import { deriveWrappingKey, unwrapSecret, wrapSecret } from '../../src/account/crypto/envelopes'
import { encryptRevision, decryptRevision } from '../../src/account/crypto/revisions'
import { CryptoError, type PlainSink } from '../../src/account/crypto/types'
import { opaqueFieldBytes, OpaqueFieldSchemas } from '../../src/account/protocol'

const password = ' e\u0301 synthetic password with spaces '
const credentialId = 'crykit/password/AAAAAAAAAAAAAAAAAAAAAA'
const accountId = 'AAAAAAAAAAAAAAAAAAAAAA'
let fixtures: ServiceFixture[] = []
afterEach(async () => { await Promise.all(fixtures.map(f => f.dispose())); fixtures = [] })
async function fixture(setup?: string) { const f = await createServiceFixture({ opaqueSetup: setup }); fixtures.push(f); return f }
async function probe(f: ServiceFixture, body: object) {
  const response = await f.request('/__accounts/probe/opaque', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  expect(response.status).toBe(200)
  return await response.json() as { response: string; state: string; ok: boolean }
}
async function register(f: ServiceFixture) {
  const start = await client.startRegistration(password)
  const response = await probe(f, { operation: 'registration', credentialId, request: start.request })
  return client.finishRegistration(start.state, response.response, password, credentialId)
}
async function login(f: ServiceFixture, record: string | null, value = password) {
  const start = await client.startLogin(value)
  const response = await probe(f, { operation: 'login', credentialId, record, request: start.request })
  return { start, response }
}
it('restoresSetupWithoutChangingExistingCredentials', async () => {
  await library.ready
  const setup = library.server.createSetup()
  const f = await fixture(setup)
  const first = await register(f)
  const firstBrowserKey = crypto.getRandomValues(new Uint8Array(32))
  const envelope = await wrapSecret(firstBrowserKey, await deriveWrappingKey(first.exportKey, accountId, 'password'), [1, accountId])
  const restored = await fixture(setup)
  const { start, response } = await login(restored, first.record)
  const result = await client.finishLogin(start.state, response.response, password, credentialId)
  expect(Object.keys(result).sort()).toEqual(['exportKey', 'request'])
  await probe(restored, { operation: 'finish', state: response.state, request: result.request })
  const restoredSetupLogin = unwrapSecret(envelope, await deriveWrappingKey(result.exportKey, accountId, 'password'), [1, accountId])
  await expect(restoredSetupLogin).resolves.toEqual(firstBrowserKey)
  const changed = await fixture()
  const changedLogin = await login(changed, first.record)
  await expect(client.finishLogin(changedLogin.start.state, changedLogin.response.response, password, credentialId)).rejects.toThrow('AUTH_FAILED')
})
it('dummyAndWrongPasswordHaveSamePublicFailure', async () => {
  const f = await fixture()
  const registered = await register(f)
  const failures = []
  for (const record of [registered.record, null]) {
    const { start, response } = await login(f, record, 'a different synthetic password')
    expect(OpaqueFieldSchemas.loginResponse.safeParse(response.response).success).toBe(true)
    await expect(client.finishLogin(start.state, response.response, 'a different synthetic password', credentialId)).rejects.toThrow('AUTH_FAILED')
    const failed = await f.request('/__accounts/probe/opaque', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'finish', state: response.state, request: Buffer.alloc(opaqueFieldBytes.finishLoginRequest).toString('base64url') }) })
    expect(failed.status).toBe(401)
    failures.push((await failed.json() as { error: { code: string } }).error.code)
  }
  const [wrongPasswordResponse, unknownAccountResponse] = failures
  expect(wrongPasswordResponse).toEqual(unknownAccountResponse)
})
it('serverSessionKeyCannotUnlockStoredRevision', async () => {
  await library.ready
  const setup = library.server.createSetup()
  const f = await fixture(setup)
  const registered = await register(f)
  const accountKey = crypto.getRandomValues(new Uint8Array(32))
  const envelope = await wrapSecret(accountKey, await deriveWrappingKey(registered.exportKey, accountId, 'password'), [1, accountId])
  const start = await client.startLogin(password)
  const server = library.server.startLogin({ serverSetup: setup, userIdentifier: credentialId, registrationRecord: registered.record, startLoginRequest: start.request, identifiers: { client: credentialId, server: client.opaqueServerIdentity } })
  const completed = await client.finishLogin(start.state, server.loginResponse, password, credentialId)
  const { sessionKey } = library.server.finishLogin({ serverLoginState: server.serverLoginState, finishLoginRequest: completed.request })
  const key = await deriveWrappingKey(new Uint8Array(Buffer.from(sessionKey, 'base64url')), accountId, 'password')
  await expect(unwrapSecret(envelope, key, [1, accountId])).rejects.toThrow()
  const chunks: Uint8Array[] = []
  async function* source() { yield new TextEncoder().encode('private revision') }
  const encrypted = await encryptRevision(accountKey, { format: 1, accountId, documentId: accountId, revisionId: accountId, parents: [], dependencies: [], protected: false, plainBytes: 16 }, accountId, source(), { id: 'synthetic', async write(_, bytes) { chunks.push(bytes.slice()) } })
  async function* cipher() { yield* chunks }
  function recordingSink() {
    const writes: Uint8Array[] = []
    const calls = { commits: 0, aborts: 0 }
    // Nonthrowing callbacks cannot manufacture the cryptographic rejection being asserted
    const sink: PlainSink = { async write(bytes) { writes.push(bytes.slice()) }, async commit() { calls.commits++ }, async abort() { calls.aborts++ } }
    return { writes, calls, sink }
  }
  const rejected = recordingSink()
  const serverSessionKeyDecryption = decryptRevision(key, encrypted.descriptor, cipher(), rejected.sink)
  await expect(serverSessionKeyDecryption).rejects.toBeInstanceOf(CryptoError)
  await expect(serverSessionKeyDecryption).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
  expect(rejected.writes).toEqual([])
  expect(rejected.calls).toEqual({ commits: 0, aborts: 1 })
  const accepted = recordingSink()
  await expect(decryptRevision(accountKey, encrypted.descriptor, cipher(), accepted.sink)).resolves.toBeUndefined()
  expect(accepted.writes).toEqual([new TextEncoder().encode('private revision')])
  expect(accepted.calls).toEqual({ commits: 1, aborts: 0 })
})
it('loads the independent emitted server-adapter WASM and leaves production probes unavailable', async () => {
  const f = await fixture()
  const started = await client.startRegistration(password)
  const response = await f.request('/__accounts/probe/opaque-adapter', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'registration', credentialId, request: started.request }) })
  expect(response.status).toBe(200)
  const registered = await client.finishRegistration(started.state, (await response.json() as { response: string }).response, password, credentialId)
  const loginStart = await client.startLogin(password)
  const loginResponse = await f.request('/__accounts/probe/opaque-adapter', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'login', credentialId, request: loginStart.request, record: registered.record }) })
  const server = await loginResponse.json() as { state: string; response: string }
  const loginFinish = await client.finishLogin(loginStart.state, server.response, password, credentialId)
  expect(loginFinish.exportKey).toEqual(registered.exportKey)
  const finish = await f.request('/__accounts/probe/opaque-adapter', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'finish', state: server.state, request: loginFinish.request }) })
  expect(await finish.json()).toEqual({ ok: true })
  expect((await f.request('/__accounts/production/opaque', { method: 'POST' })).status).toBe(404)
  const serverDump = JSON.stringify({ events: f.events(), emails: await f.emails(), tables: await f.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(), objects: await f.objects.list() })
  expect(serverDump).not.toContain(password)
  expect(serverDump).not.toContain(Buffer.from(registered.exportKey).toString('base64url'))
})
it('binds the exact KDF profile and stable credential role', async () => {
  await library.ready
  const setup = library.server.createSetup()
  const f = await fixture(setup)
  const registered = await register(f)
  const start = await client.startLogin(password)
  const server = library.server.startLogin({ serverSetup: setup, userIdentifier: credentialId, registrationRecord: registered.record, startLoginRequest: start.request, identifiers: { client: credentialId, server: client.opaqueServerIdentity } })
  expect(library.client.finishLogin({ clientLoginState: start.state, loginResponse: server.loginResponse, password, identifiers: { client: credentialId, server: client.opaqueServerIdentity }, keyStretching: { 'argon2id-custom': { memory: 65536, iterations: 3, parallelism: 1 } } })).toBeUndefined()
  await expect(client.finishLogin(start.state, server.loginResponse, password, credentialId.replace('/password/', '/recovery/'))).rejects.toThrow('AUTH_FAILED')
  expect((await client.finishLogin(start.state, server.loginResponse, password, credentialId)).exportKey).toEqual(registered.exportKey)
})
