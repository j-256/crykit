import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readProtectedRecoverySecrets } from '../operations/recovery-secret-source'
import { expect, it } from 'vitest'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'
import { createServiceFixture } from '../testing/service-fixture'
import { createServiceContext, type ServiceEnv } from '../context'
import { initializeRevocationLedger } from './ledger'
import { captureServiceSnapshot } from './service-backup'
import { closeServiceForRecovery, promoteServiceRestore, restoreServiceSnapshot } from './service-restore'
import { recoverySecretNames } from './recovery-codec'
import { randomId } from '../auth/identity'

type BrowserToken = { accountId: string; generation: number }
type BrowserDatabase = {
  outbox: { toArray(): Promise<unknown[]> }
  syncState: { get(id: string): Promise<unknown> }
  profileMeta: { get(id: string): Promise<unknown> }
  delete(): Promise<void>
}
type BrowserRepository = {
  load(): Promise<{ localData: unknown; revision: number }>
  save(value: unknown, revision: number): Promise<unknown>
  readWorkspace(): Promise<unknown>
}
// The cross-realm browser module boundary is structural; production modules keep their own DOM typecheck
// Importing their DOM implementation graph here would merge it into the isolated Worker runtime globals
type RecoveryClient = {
  profile: { installProfile(id: string, key: Uint8Array): BrowserToken }
  database: { AccountDatabase: new (id: string) => BrowserDatabase }
  repository: { openAccountRepository(token: BrowserToken): Promise<BrowserRepository> }
  pull: {
    stagePull(
      database: BrowserDatabase,
      token: BrowserToken,
      client: { changes(): Promise<unknown> },
      validate: () => Promise<void>,
      budget: unknown,
    ): Promise<unknown>
    readRemoteState(
      database: BrowserDatabase,
      token: BrowserToken,
    ): Promise<{ value: { watermark: number } } | undefined>
  }
  outbox: {
    writeSyncState(
      database: BrowserDatabase,
      token: BrowserToken,
      id: string,
      value: unknown,
      expected: undefined,
      dependencies: unknown[],
    ): Promise<unknown>
    transferBudget(): unknown
  }
  publication: {
    stagePublicationPages(
      database: BrowserDatabase,
      token: BrowserToken,
      kind: string,
      heads: unknown[],
      dependencies: () => unknown[],
    ): Promise<unknown>
  }
}
type BrowserAuth = {
  accountId: string
  attemptId: string
  credentialId: string
  registrationResponse: string
  loginResponse: string
  csrf: string
  accountEnvelope: import('../../src/account/protocol').KeyEnvelope
}
type RecoveryModules = {
  opaque: typeof import('../../src/account/crypto/opaque')
  envelopes: typeof import('../../src/account/crypto/envelopes')
  revisions: typeof import('../../src/account/crypto/revisions')
}

it('restoredSecretsKeepExistingPasswordAccess', async () => {
  const policy = JSON.stringify({
    version: 1,
    maxRows: 10000,
    maxBytes: 8 * 1024 * 1024,
    maxEdges: 10000,
    maxWork: 20000,
    maxTemporaryBytes: 64 * 1024 * 1024,
    maxStatements: 100,
    maxRowBytes: 1_900_000,
  })
  const original = await createServiceFixture({ recoveryPolicy: policy })
  const sourceDirectory = await mkdtemp(join(tmpdir(), 'crykit-recovery-secrets-')),
    sourcePath = join(sourceDirectory, 'original-service-secrets.json')
  await writeFile(
    sourcePath,
    JSON.stringify({
      version: 1,
      environment: 'local',
      secrets: Object.fromEntries(recoverySecretNames.map((key) => [key, original.env[key]])),
    }),
    { mode: 0o600 },
  )
  const target = await createServiceFixture({
    recoverySecrets: await readProtectedRecoverySecrets(sourcePath, 'local'),
  })
  const source = createServiceContext(new Request('http://127.0.0.1'), original.env as unknown as ServiceEnv, {
    now: () => Date.now(),
    emit() {},
  })
  const staged = createServiceContext(
    new Request('http://127.0.0.1'),
    {
      ...target.env,
      LEDGER_BACKUPS: original.env.LEDGER_BACKUPS,
      REVOCATION_LEDGER: original.env.REVOCATION_LEDGER,
    } as unknown as ServiceEnv,
    { now: () => Date.now(), emit() {} },
  )
  const vite = await createServer({ server: { port: 0, host: '127.0.0.1' }, logLevel: 'silent' })
  const browser = await chromium.launch({ headless: true })
  try {
    await vite.listen()
    const address = vite.httpServer!.address() as { port: number },
      origin = `http://127.0.0.1:${address.port}`
    let active = original
    const browserContext = await browser.newContext()
    await browserContext.route('**/api/v1/**', async (route) => {
      const request = route.request(),
        response = await active.request(new URL(request.url()).pathname, {
          method: request.method(),
          headers: { ...request.headers(), origin: 'http://127.0.0.1' },
          body: request.postDataBuffer() ?? undefined,
        })
      await route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: Buffer.from(await response.arrayBuffer()),
      })
    })
    await browserContext.route(`${origin}/`, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Isolated service recovery rehearsal</title>',
      }),
    )
    const page = await browserContext.newPage()
    await page.goto(origin)
    await page.addScriptTag({
      type: 'module',
      content:
        "Promise.all(['/src/account/crypto/opaque.ts','/src/account/crypto/envelopes.ts','/src/account/crypto/revisions.ts'].map(path=>import(path))).then(([opaque,envelopes,revisions])=>{window.recoveryModules={opaque,envelopes,revisions}})",
    })
    await page.waitForFunction('window.recoveryModules')
    const registered = await page.evaluate(async () => {
      const { opaque, envelopes } = (globalThis as unknown as { recoveryModules: RecoveryModules }).recoveryModules
      const api = async (path: string, body: unknown) => {
        const response = await fetch(`/api/v1/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json() as Promise<BrowserAuth>
      }
      const password = 'Original browser service recovery password',
        key = crypto.getRandomValues(new Uint8Array(32)),
        registration = await opaque.startRegistration(password)
      const started = await api('auth/signup/start', {
        email: 'recovery@example.org',
        username: 'recover_user',
        registrationRequest: registration.request,
      })
      const finished = await opaque.finishRegistration(
        registration.state,
        started.registrationResponse,
        password,
        started.credentialId,
      )
      const envelope = await envelopes.wrapSecret(
        key,
        await envelopes.deriveWrappingKey(finished.exportKey, started.accountId, 'password'),
        [1, started.accountId],
      )
      const id = () =>
        btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
          .replaceAll('+', '-')
          .replaceAll('/', '_')
          .replaceAll('=', '')
      await api('auth/signup/finish', {
        attemptId: started.attemptId,
        transactionId: id(),
        registrationRecord: finished.record,
        accountEnvelope: envelope,
        remember: true,
      })
      const keyDigest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', key)))
      Object.assign(globalThis, { recoveryTest: { password, key, api, id, accountId: started.accountId } })
      return { accountId: started.accountId, keyDigest }
    })
    await original.runJobs()
    const capability = (await original.emails()).at(-1)!.capability
    const originalData = await page.evaluate(async (capability) => {
      const state = (
        globalThis as unknown as {
          recoveryTest: {
            password: string
            key: Uint8Array
            api: (path: string, body: unknown) => Promise<Record<string, string>>
            id: () => string
            accountId: string
          }
        }
      ).recoveryTest
      const { opaque, revisions } = (globalThis as unknown as { recoveryModules: RecoveryModules }).recoveryModules
      await state.api('auth/verify', { capability })
      const login = await opaque.startLogin(state.password),
        challenge = await state.api('auth/login/start', {
          email: 'recovery@example.org',
          role: 'password',
          startLoginRequest: login.request,
        })
      const finished = await opaque.finishLogin(
          login.state,
          challenge.loginResponse,
          state.password,
          challenge.credentialId,
        ),
        session = await state.api('auth/login/finish', {
          attemptId: challenge.attemptId,
          finishLoginRequest: finished.request,
          remember: true,
        })
      const plain = new TextEncoder().encode('Original encrypted service recovery bytes'),
        chunks: Uint8Array[] = []
      async function* input() {
        yield plain
      }
      const encrypted = await revisions.encryptRevision(
        state.key,
        {
          format: 1,
          accountId: state.accountId,
          documentId: state.id(),
          revisionId: state.id(),
          parents: [],
          dependencies: [],
          protected: true,
          plainBytes: plain.length,
        },
        state.id(),
        input(),
        {
          id: 'recovery-fixture',
          async write(_index: number, bytes: Uint8Array) {
            chunks.push(bytes.slice())
          },
        },
      )
      const descriptor = encrypted.descriptor,
        headers = { 'content-type': 'application/json', 'x-csrf-token': session.csrf }
      const start = await fetch('/api/v1/sync/uploads', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          version: 1,
          uploadId: descriptor.uploadId,
          documentId: descriptor.documentId,
          revisionId: descriptor.revisionId,
          metadataBytes: new TextEncoder().encode(JSON.stringify(descriptor)).length,
          chunks: descriptor.chunks,
        }),
      })
      if (!start.ok) throw new Error(`Upload ${start.status}`)
      for (const [index, bytes] of chunks.entries()) {
        const r = await fetch(`/api/v1/sync/uploads/${descriptor.uploadId}/chunks/${index}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream', 'x-csrf-token': session.csrf },
          body: bytes,
        })
        if (!r.ok) throw new Error(`Chunk ${r.status}`)
      }
      for (const [path, body] of [
        [`sync/uploads/${descriptor.uploadId}/finish`, { version: 1 }],
        [
          'sync/commits',
          {
            version: 1,
            mutationId: state.id(),
            revisions: [descriptor],
            heads: [{ documentId: descriptor.documentId, revisionId: descriptor.revisionId }],
            expected: [{ documentId: descriptor.documentId, revisionId: null }],
          },
        ],
      ] as const) {
        const r = await fetch(`/api/v1/${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
        if (!r.ok) throw new Error(`Commit ${r.status}`)
      }
      Object.assign(state, { csrf: session.csrf })
      return {
        documentId: descriptor.documentId,
        revisionId: descriptor.revisionId,
        ciphertext: chunks.map((bytes) => Array.from(bytes)),
      }
    }, capability)
    await initializeRevocationLedger(source)
    const snapshot = randomId()
    for (let i = 0; i < 1500; i++) if ((await captureServiceSnapshot(source, snapshot)).state === 'complete') break
    expect(
      await original.db.prepare('SELECT state FROM service_snapshots WHERE id=?').bind(snapshot).first('state'),
    ).toBe('complete')
    const backupListing = await original.backups.list({ limit: 1000 })
    expect(backupListing.truncated).toBe(false)
    const backupBodies = await Promise.all(
      backupListing.objects.map(async (object) =>
        Array.from(new Uint8Array(await (await original.backups.get(object.key))!.arrayBuffer())),
      ),
    )
    const backupContainsPlainAccountKey = await page.evaluate((bodies) => {
      const key = (globalThis as unknown as { recoveryTest: { key: Uint8Array } }).recoveryTest.key
      const encoded = btoa(String.fromCharCode(...key))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '')
      const needles = [
        key,
        new TextEncoder().encode(encoded),
        new TextEncoder().encode('Original encrypted service recovery bytes'),
      ]
      return bodies.some((body) =>
        needles.some((needle) =>
          body.some(
            (_, offset) =>
              offset + needle.length <= body.length && needle.every((byte, index) => body[offset + index] === byte),
          ),
        ),
      )
    }, backupBodies)
    expect(backupContainsPlainAccountKey).toBe(false)
    await page.addScriptTag({
      type: 'module',
      content:
        "Promise.all(['/src/account/profile.ts','/src/persistence/account-database.ts','/src/workspace/account-repository.ts','/src/account/sync/pull.ts','/src/account/sync/outbox.ts','/src/account/sync/publication.ts'].map(path=>import(path))).then(([profile,database,repository,pull,outbox,publication])=>{window.recoveryClient={profile,database,repository,pull,outbox,publication}})",
    })
    await page.waitForFunction('window.recoveryClient')
    await page.evaluate(async ({ documentId, revisionId }) => {
      const state = (
        globalThis as unknown as {
          recoveryTest: { key: Uint8Array; accountId: string; csrf: string; id: () => string }
        }
      ).recoveryTest
      const modules = (globalThis as unknown as { recoveryClient: RecoveryClient }).recoveryClient
      const response = await fetch('/api/v1/sync/commits', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': state.csrf },
        body: JSON.stringify({
          version: 1,
          mutationId: state.id(),
          revisions: [],
          heads: [{ documentId, revisionId }],
          expected: [{ documentId, revisionId }],
        }),
      })
      if (!response.ok) throw new Error(`Newer commit ${response.status}`)
      const receipt = (await response.json()) as { sequence: number; publicationEpoch: number },
        token = modules.profile.installProfile(state.accountId, state.key),
        database = new modules.database.AccountDatabase(state.accountId),
        repository = await modules.repository.openAccountRepository(token)
      const loaded = await repository.load()
      await repository.save(loaded.localData, loaded.revision)
      const heads = await modules.publication.stagePublicationPages(
        database,
        token,
        'local-remote-heads',
        [{ documentId, revisionId }],
        () => [],
      )
      await modules.outbox.writeSyncState(
        database,
        token,
        'remote',
        {
          version: 1,
          kind: 'remote-state',
          cursor: null,
          watermark: receipt.sequence,
          publicationEpoch: receipt.publicationEpoch,
          heads,
          initialComplete: true,
        },
        undefined,
        [heads],
      )
      const before = {
        workspace: await repository.readWorkspace(),
        outbox: await database.outbox.toArray(),
        remote: await database.syncState.get('remote'),
        fence: await database.profileMeta.get('active'),
      }
      if (!before.outbox.length) throw new Error('Expected real local pending work')
      Object.assign(state, { token, database, repository, before })
    }, originalData)
    await closeServiceForRecovery(staged)
    for (let i = 0; i < 2000; i++) {
      await restoreServiceSnapshot(staged, snapshot)
      if ((await target.db.prepare('SELECT state FROM recovery_control').first('state')) === 'verified') break
    }
    expect(await target.db.prepare('SELECT state FROM recovery_control').first('state')).toBe('verified')
    await closeServiceForRecovery(source)
    await promoteServiceRestore(staged, source)
    active = target
    // A new browser page has no retained account key; the original password must recover it
    const fresh = await browserContext.newPage()
    await fresh.goto(origin)
    await fresh.addScriptTag({
      type: 'module',
      content:
        "Promise.all(['/src/account/crypto/opaque.ts','/src/account/crypto/envelopes.ts','/src/account/crypto/revisions.ts'].map(path=>import(path))).then(([opaque,envelopes,revisions])=>{window.recoveryModules={opaque,envelopes,revisions}})",
    })
    await fresh.waitForFunction('window.recoveryModules')
    const recovered = await fresh.evaluate(async ({ revisionId }) => {
      const { opaque, envelopes, revisions } = (globalThis as unknown as { recoveryModules: RecoveryModules })
        .recoveryModules
      const api = async (path: string, body: unknown) => {
        const response = await fetch(`/api/v1/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!response.ok) throw new Error(`Login ${response.status}`)
        return response.json() as Promise<BrowserAuth>
      }
      const password = 'Original browser service recovery password',
        login = await opaque.startLogin(password),
        challenge = await api('auth/login/start', {
          email: 'recovery@example.org',
          role: 'password',
          startLoginRequest: login.request,
        }),
        finished = await opaque.finishLogin(login.state, challenge.loginResponse, password, challenge.credentialId)
      const session = await api('auth/login/finish', {
        attemptId: challenge.attemptId,
        finishLoginRequest: finished.request,
        remember: true,
      })
      const key = await envelopes.unwrapSecret(
        session.accountEnvelope,
        await envelopes.deriveWrappingKey(finished.exportKey, session.accountId, 'password'),
        [1, session.accountId],
      )
      const descriptor = (await (
          await fetch(`/api/v1/sync/revisions/${revisionId}`)
        ).json()) as import('../../src/account/protocol').RevisionDescriptor,
        chunks: Uint8Array[] = []
      for (const chunk of descriptor.chunks) {
        const r = await fetch(`/api/v1/sync/revisions/${revisionId}/chunks/${chunk.index}`)
        if (!r.ok) throw new Error(`Read ${r.status}`)
        chunks.push(new Uint8Array(await r.arrayBuffer()))
      }
      async function* input() {
        yield* chunks
      }
      const plain: number[] = []
      let committed = false
      await revisions.decryptRevision(key, descriptor, input(), {
        async write(bytes: Uint8Array) {
          plain.push(...bytes)
        },
        async commit() {
          committed = true
        },
        async abort() {
          plain.length = 0
        },
      })
      return {
        keyDigest: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', key))),
        ciphertext: chunks.map((bytes) => Array.from(bytes)),
        plain: new TextDecoder().decode(Uint8Array.from(plain)),
        committed,
      }
    }, originalData)
    expect(recovered.keyDigest).toEqual(registered.keyDigest)
    expect(recovered.ciphertext).toEqual(originalData.ciphertext)
    expect(recovered.plain).toBe('Original encrypted service recovery bytes')
    expect(recovered.committed).toBe(true)
    const rollback = await page.evaluate(async () => {
      const state = (
        globalThis as unknown as {
          recoveryTest: {
            token: BrowserToken
            database: BrowserDatabase
            repository: BrowserRepository
            before: unknown
          }
        }
      ).recoveryTest
      const modules = (globalThis as unknown as { recoveryClient: RecoveryClient }).recoveryClient
      const client = {
        changes: async () => {
          const response = await fetch('/api/v1/sync/changes')
          if (!response.ok) throw new Error(`Changes ${response.status}`)
          return response.json()
        },
      }
      let code = ''
      try {
        await modules.pull.stagePull(
          state.database,
          state.token,
          client,
          async () => {
            throw new Error('Lower restore must reject before projection')
          },
          modules.outbox.transferBudget(),
        )
      } catch (error) {
        code = (error as { code: string }).code
      }
      const after = {
        workspace: await state.repository.readWorkspace(),
        outbox: await state.database.outbox.toArray(),
        remote: await state.database.syncState.get('remote'),
        fence: await state.database.profileMeta.get('active'),
      }
      const result = {
        code,
        unchanged: JSON.stringify(after) === JSON.stringify(state.before),
        pending: after.outbox.length,
        watermark: (await modules.pull.readRemoteState(state.database, state.token))?.value.watermark,
      }
      await state.database.delete()
      return result
    })
    expect(rollback).toMatchObject({ code: 'STALE_CURSOR', unchanged: true, watermark: 2 })
    expect(rollback.pending).toBeGreaterThan(0)
    await browserContext.close()
  } finally {
    await browser.close()
    await vite.close()
    await original.dispose()
    await target.dispose()
    await rm(sourceDirectory, { recursive: true, force: true })
  }
}, 120_000)
