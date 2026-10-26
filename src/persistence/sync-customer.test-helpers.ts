import { expect } from 'vitest'
import * as opaque from '../account/crypto/opaque'
import { accountLocalId } from '../workspace/account-cache'
import type { ServiceFixture } from '../../worker/testing/service-fixture'
import type { UnlockResult } from '../account/auth-client'

const password = 'synthetic sync acceptance password'
function post(f: ServiceFixture, path: string, body: object) { return f.request(`/api/v1/${path}`, { method: 'POST', headers: { origin: 'http://127.0.0.1', 'content-type': 'application/json' }, body: JSON.stringify(body) }) }
export async function customer(f: ServiceFixture, name = 'sync') {
  const registration = await opaque.startRegistration(password)
  const started = await post(f, 'auth/signup/start', { email: `${name}@example.org`, username: `${name}_user`, registrationRequest: registration.request })
  expect(started.status).toBe(200)
  const start = await started.json() as { attemptId: string; accountId: string; credentialId: string; registrationResponse: string }
  const registered = await opaque.finishRegistration(registration.state, start.registrationResponse, password, start.credentialId)
  expect((await post(f, 'auth/signup/finish', { attemptId: start.attemptId, transactionId: accountLocalId(), registrationRecord: registered.record, accountEnvelope: { version: 1, algorithm: 'xchacha20poly1305-ietf', nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('base64url'), ciphertext: Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString('base64url') }, remember: true })).status).toBe(200)
  await f.runJobs()
  expect((await post(f, 'auth/verify', { capability: (await f.emails()).at(-1)!.capability })).status).toBe(200)
  const login = await opaque.startLogin(password)
  const challenge = await (await post(f, 'auth/login/start', { email: `${name}@example.org`, role: 'password', startLoginRequest: login.request })).json() as { attemptId: string; credentialId: string; loginResponse: string }
  const finish = await opaque.finishLogin(login.state, challenge.loginResponse, password, challenge.credentialId)
  const response = await post(f, 'auth/login/finish', { attemptId: challenge.attemptId, finishLoginRequest: finish.request, remember: true })
  expect(response.status).toBe(200)
  const session = await response.json() as Omit<UnlockResult, 'key'>
  return { ...session, headers: { cookie: response.headers.get('set-cookie')!.split(';')[0], 'x-csrf-token': session.csrf } }
}
