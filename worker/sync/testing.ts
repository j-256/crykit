import { afterEach, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import * as opaque from '../../src/account/crypto/opaque'
import { createServiceFixture, type ServiceFixture } from '../testing/service-fixture'

const fixtures: ServiceFixture[] = []
export const id = () => randomBytes(16).toString('base64url')
const password = 'synthetic sync acceptance password'
afterEach(async () => { await Promise.all(fixtures.splice(0).map(f => f.dispose())) })
export async function fixture() { const f = await createServiceFixture({ now: 1_800_000_000_000 }); fixtures.push(f); return f }
export function post(f: ServiceFixture, path: string, body: object, headers: Record<string, string> = {}) {
  return f.request(`/api/v1/${path}`, { method: 'POST', headers: { origin: 'http://127.0.0.1', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
}
export async function customer(f: ServiceFixture, name = 'sync') {
  const registration = await opaque.startRegistration(password)
  const started = await post(f, 'auth/signup/start', { email: `${name}@example.org`, username: `${name}_user`, registrationRequest: registration.request })
  expect(started.status).toBe(200)
  const start = await started.json() as { attemptId: string; accountId: string; credentialId: string; registrationResponse: string }
  const registered = await opaque.finishRegistration(registration.state, start.registrationResponse, password, start.credentialId)
  expect((await post(f, 'auth/signup/finish', { attemptId: start.attemptId, transactionId: id(), registrationRecord: registered.record, accountEnvelope: { version: 1, algorithm: 'xchacha20poly1305-ietf', nonce: randomBytes(24).toString('base64url'), ciphertext: randomBytes(48).toString('base64url') }, remember: true })).status).toBe(200)
  await f.runJobs()
  expect((await post(f, 'auth/verify', { capability: (await f.emails()).at(-1)!.capability })).status).toBe(200)
  const login = await opaque.startLogin(password)
  const challenge = await (await post(f, 'auth/login/start', { email: `${name}@example.org`, role: 'password', startLoginRequest: login.request })).json() as { attemptId: string; credentialId: string; loginResponse: string }
  const finish = await opaque.finishLogin(login.state, challenge.loginResponse, password, challenge.credentialId)
  const response = await post(f, 'auth/login/finish', { attemptId: challenge.attemptId, finishLoginRequest: finish.request, remember: true })
  expect(response.status).toBe(200)
  const session = await response.json() as { csrf: string; accountId: string }
  return { ...session, headers: { cookie: response.headers.get('set-cookie')!.split(';')[0], 'x-csrf-token': session.csrf } }
}

export async function prepared(f: ServiceFixture, signed: Awaited<ReturnType<typeof customer>>, options: Partial<import('../../src/account/protocol').RevisionDescriptor> = {}, bytes = randomBytes(33)) {
  const cipherDigest = (await import('node:crypto')).createHash('sha256').update(bytes).digest('base64url')
  const descriptor: import('../../src/account/protocol').RevisionDescriptor = {
    format: 1, accountId: signed.accountId, documentId: id(), revisionId: id(), parents: [], dependencies: [], protected: false, plainBytes: 16,
    keyEnvelope: { version: 1, algorithm: 'xchacha20poly1305-ietf', nonce: randomBytes(24).toString('base64url'), ciphertext: randomBytes(48).toString('base64url') }, streamHeader: randomBytes(24).toString('base64url'), uploadId: id(), chunks: [{ index: 0, cipherBytes: bytes.length, cipherDigest }], ...options,
  }
  const input = { version: 1 as const, uploadId: descriptor.uploadId, documentId: descriptor.documentId, revisionId: descriptor.revisionId, metadataBytes: Buffer.byteLength(JSON.stringify(descriptor)), chunks: descriptor.chunks }
  expect((await post(f, 'sync/uploads', input, signed.headers)).status).toBe(200)
  expect((await f.request(`/api/v1/sync/uploads/${input.uploadId}/chunks/0`, { method: 'PUT', headers: { origin: 'http://127.0.0.1', 'content-type': 'application/octet-stream', ...signed.headers }, body: bytes })).status).toBe(200)
  expect((await post(f, `sync/uploads/${input.uploadId}/finish`, { version: 1 }, signed.headers)).status).toBe(200)
  return { descriptor, input, bytes }
}
export function command(revisions: readonly import('../../src/account/protocol').RevisionDescriptor[], heads = revisions.map(r => ({documentId:r.documentId,revisionId:r.revisionId})), expected = heads.map(h => ({documentId:h.documentId,revisionId:null as string|null}))): import('../../src/account/protocol').CommitRequest {
  return {version:1,mutationId:id(),revisions,heads,expected}
}
export async function direct(f: ServiceFixture, signed: Awaited<ReturnType<typeof customer>>, now = 1_800_000_000_000) {
  const row = await f.db.prepare('SELECT id,device_id,authenticated_at,absolute_expires_at FROM customer_sessions WHERE account_id = ? ORDER BY authenticated_at DESC LIMIT 1').bind(signed.accountId).first<{id:string;device_id:string;authenticated_at:number;absolute_expires_at:number}>()
  const context: import('../context').ServiceContext = { env: {DB:f.db,OBJECTS:f.objects as unknown as R2Bucket,STORAGE_CAP_BYTES:'2147483648'}, now:()=>now,requestId:id(),emit:()=>{},checkpoint:()=>{} }
  const principal: import('../auth/session').CustomerPrincipal = {accountId:signed.accountId,sessionId:row!.id,deviceId:row!.device_id,authenticatedAt:row!.authenticated_at,absoluteExpiresAt:row!.absolute_expires_at,access:'active'}
  return {context,principal}
}

export async function measurement(name: string, values: object): Promise<void> {
  const path=process.env.CRYKIT_SYNC_MEASUREMENTS
  if(path) await (await import('node:fs/promises')).appendFile(path,JSON.stringify({name,...values})+'\n')
}

export { measuredDatabase } from '../testing/measured-database'
