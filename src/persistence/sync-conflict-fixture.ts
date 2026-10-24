import 'fake-indexeddb/auto'
import { appendFileSync } from 'node:fs'
import Dexie from 'dexie'
import { IDBFactory } from 'fake-indexeddb'
import { expect, vi } from 'vitest'
import * as opaque from '../account/crypto/opaque'
import type { UnlockResult } from '../account/auth-client'
import { createServiceFixture, type ServiceFixture } from '../../worker/testing/service-fixture'
import { AccountDatabase } from './account-database'
import { prepareManagedSync, seedManagedWorkspace, openManagedNativeWorkspace } from './managed-sync.test-helpers'
import { installProfile, invalidateProfile } from '../account/profile'
import { accountLocalId } from '../workspace/account-cache'
import { openAccountRepository } from '../workspace/account-repository'
import { EncryptedOutbox, transferBudget, registerSyncProjectionGuard, runSyncIteration } from '../account/sync/outbox'
import { SyncClient, SyncError } from '../account/sync/client'
import type { WorkspaceState } from '../workspace/documents'
import type { CommitRequest } from '../account/protocol'
const password = 'synthetic lineage conflict password'
const post = (f: ServiceFixture, path: string, body: unknown) => f.request(`/api/v1/${path}`, { method: 'POST', headers: { origin: 'http://127.0.0.1', 'content-type': 'application/json' }, body: JSON.stringify(body) })
async function customer(f: ServiceFixture, name = 'sync') {
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

export async function conflictService() {
  const fixture = await createServiceFixture({ now: 1_800_000_000_000 }), session = await customer(fixture, 'lineages')
  const key = crypto.getRandomValues(new Uint8Array(32)), previousFactory = Dexie.dependencies.indexedDB
  const factories = [new IDBFactory(), new IDBFactory(), new IDBFactory()], databases: AccountDatabase[] = [], commits: CommitRequest[] = []
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    if (path.endsWith('/commits')) commits.push(JSON.parse(init.body as string))
    const headers = new Headers(init.headers); headers.set('cookie', session.headers.cookie); headers.set('origin', 'http://127.0.0.1')
    return fixture.request(path, { ...init, headers })
  })
  return { fixture, commits,
    async device(index: number, initial?: WorkspaceState) {
      invalidateProfile(); Dexie.dependencies.indexedDB = factories[index]
      const token = installProfile(session.accountId, key.slice(), session), db = new AccountDatabase(token.accountId); databases.push(db)
      if (initial && !await db.profileMeta.get('active')) {
        await seedManagedWorkspace(db, token, initial)
      }
      const repo = await openAccountRepository(token)
      registerSyncProjectionGuard(token, () => true)
      const client = new SyncClient(token, new AbortController().signal), outbox = new EncryptedOutbox(db, token)
      return { token, db, repo,
        // New test operations explicitly open the selected owner; captured old repositories stay fenced
        async open() { return openAccountRepository(token) },
        async native() { return openManagedNativeWorkspace(db, token) },
        async publish(input: CommitRequest) {
          await outbox.prepare(input)
          for (let turn = 0; turn < 240; turn++) {
            try { const result = await outbox.advance(input.mutationId, client, transferBudget()); if (result) return result }
            catch (error) { if (!(error instanceof SyncError && error.code === 'SERVICE_UNAVAILABLE')) throw error }
          }
          throw new Error('Publication did not settle')
        },
        async settle() {
          const started = Date.now()
          for (let turn = 0; turn < 240; turn++) {
            try { await prepareManagedSync(db, token); const result = await runSyncIteration(token, new AbortController().signal); if (process.env.CRYKIT_SYNC_PROOF_TIMINGS && (!result.moreWork || turn % 10 === 0)) appendFileSync(process.env.CRYKIT_SYNC_PROOF_TIMINGS, `${JSON.stringify({ device: index, turn, state: result.state, moreWork: result.moreWork, elapsedMs: Date.now() - started })}\n`); if (!result.moreWork) return result }
            catch (error) { if (!(error instanceof SyncError && error.code === 'SERVICE_UNAVAILABLE')) throw error }
          }
          throw new Error('Conflict sync did not settle')
        },
      }
    },
    async dispose() { invalidateProfile(); vi.unstubAllGlobals(); for (const database of databases) database.close(); for (const factory of factories) { Dexie.dependencies.indexedDB = factory; await new AccountDatabase(session.accountId).delete() }; Dexie.dependencies.indexedDB = previousFactory; await fixture.dispose() },
  }
}
