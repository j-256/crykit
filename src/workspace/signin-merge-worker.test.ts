import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('./signin-merge-preparation', () => ({ createSigninMergePreparation: mocks.create }))
vi.mock('../persistence/account-database', () => ({ AccountDatabase: class { async open() {} isOpen() { return true } close() {} } }))
vi.mock('../account/profile', () => ({ installProfile: () => ({}), invalidateProfile() {}, assertActiveProfile() {} }))
vi.mock('../account/background-work', () => ({ installAccountWorkCheckpoint() {} }))
let cancel: (() => void) | undefined
afterEach(() => { cancel?.(); cancel = undefined; vi.unstubAllGlobals(); vi.resetAllMocks() })

it.each(['enabled', 'disabled', 'throwing-send', 'cancelled'] as const)('keeps real resource failure and terminal codec reporting intact with diagnostics=%s', async mode => {
  vi.resetModules()
  const replies: any[] = []
  const realm = { onmessage: undefined as ((event: MessageEvent) => void) | undefined, postMessage(value: any) {
    if (mode === 'throwing-send' && value.value?.resourceFailure) throw new Error('synthetic diagnostic send failure')
    replies.push(structuredClone(value))
  } }
  vi.stubGlobal('self', realm)
  const { assertSigninMergeBudget, SIGNIN_MERGE_LIMITS } = await import('./signin-merge-protocol')
  const { encodeBackupJson } = await import('../interchange/workspace-backup-json')
  await import('./signin-merge-worker')
  const send = (value: object) => realm.onmessage!({ data: { incarnation: 'synthetic-worker', ...value } } as MessageEvent)
  cancel = () => send({ kind: 'cancel' })
  send({ kind: 'initialize', accountId: 'synthetic-account', key: new Uint8Array(32), ...(mode === 'disabled' ? {} : { diagnostics: true }) })
  await expect.poll(() => replies.length).toBe(1)
  expect(replies[0].status).toBe('ready')
  let release: (() => void) | undefined, entered = false
  const blocked = new Promise<void>(resolve => { release = resolve })
  mocks.create.mockImplementation(async () => {
    entered = true
    if (mode === 'cancelled') await blocked
    ;[...encodeBackupJson({ synthetic: true })]
    assertSigninMergeBudget(0, 2, SIGNIN_MERGE_LIMITS.observationBytes + 17)
  })
  const id = () => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url')
  const head = { documentId: id(), revisionId: id() }, operationId = id()
  const request = { kind: 'review', id: 'request', operationId, locator: { databaseName: 'synthetic-source', manifest: { version: 3, id: 'source', revision: 0, root: head } }, fence: { selected: { key: 'active', headRevision: 1, head }, projection: { id: 'projection', ref: head }, epoch: 1, heads: [head] } }
  send({ ...request, incarnation: 'foreign' })
  expect(mocks.create).not.toHaveBeenCalled()
  send(request)
  await expect.poll(() => entered).toBe(true)
  if (mode === 'cancelled') {
    cancel(); release!()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(replies).toHaveLength(1)
    return
  }
  await expect.poll(() => replies.at(-1)?.status).toBe('failed')
  const events = replies.slice(1)
  expect(events.at(-1)).toEqual({ incarnation: 'synthetic-worker', id: 'request', operationId, status: 'failed', code: 'SIGNIN_MERGE_RESOURCE_LIMIT' })
  const resource = events.filter(value => value.value?.resourceFailure)
  expect(resource).toHaveLength(mode === 'enabled' ? 1 : 0)
  if (resource.length) expect(resource[0]).toMatchObject({ id: 'request', operationId, value: { resourceFailure: { dimension: 'observationBytes', value: SIGNIN_MERGE_LIMITS.observationBytes + 17, limit: SIGNIN_MERGE_LIMITS.observationBytes, basis: 'counted-byte-prefix', records: 2 } } })
  const codec = events.filter(value => value.value?.codec)
  expect(codec).toHaveLength(mode === 'disabled' ? 0 : 1)
  if (codec.length) expect(codec[0].value.codec.encodedOutputBytes).toBeGreaterThan(0)
  expect(events.slice(0, -1).every(value => value.status === 'progress')).toBe(true)
  expect(JSON.stringify(events)).not.toContain('synthetic diagnostic send failure')
})

it.each(['released', 'disposal-failed', 'cancelled'] as const)('releases failed preparation authority before its terminal reply: %s', async mode => {
  vi.resetModules()
  const replies: any[] = []
  const realm = { onmessage: undefined as ((event: MessageEvent) => void) | undefined, postMessage: (value: unknown) => replies.push(structuredClone(value)) }
  vi.stubGlobal('self', realm)
  const { assertSigninMergeBudget, SIGNIN_MERGE_LIMITS } = await import('./signin-merge-protocol')
  const { encodeBackupJson } = await import('../interchange/workspace-backup-json')
  await import('./signin-merge-worker')
  const send = (value: object) => realm.onmessage!({ data: { incarnation: 'synthetic-worker', ...value } } as MessageEvent)
  cancel = () => send({ kind: 'cancel' })
  send({ kind: 'initialize', accountId: 'synthetic-account', key: new Uint8Array(32), diagnostics: true })
  await expect.poll(() => replies.at(-1)?.status).toBe('ready')
  let release!: () => void, released = false
  const held = new Promise<void>(resolve => { release = resolve })
  const dispose = vi.fn(async () => {
    await held
    ;[...encodeBackupJson({ cleanup: true })]
    released = true
    if (mode === 'disposal-failed') throw new Error('synthetic private disposal failure')
  })
  const prepare = vi.fn(async () => { assertSigninMergeBudget(0, 2, SIGNIN_MERGE_LIMITS.observationBytes + 17) })
  mocks.create.mockResolvedValue({ handle: 'review-handle', preview: {}, prepare, dispose })
  const id = () => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url')
  const head = { documentId: id(), revisionId: id() }, operationId = id()
  send({ kind: 'review', id: 'review', operationId, locator: { databaseName: 'synthetic-source', manifest: { version: 3, id: 'source', revision: 0, root: head } }, fence: { selected: { key: 'active', headRevision: 1, head }, projection: { id: 'projection', ref: head }, epoch: 1, heads: [head] } })
  await expect.poll(() => replies.at(-1)?.status).toBe('complete')
  const offset = replies.length
  send({ kind: 'prepare', id: 'prepare', operationId, handle: 'review-handle', incarnation: 'foreign' })
  expect(prepare).not.toHaveBeenCalled()
  send({ kind: 'prepare', id: 'prepare', operationId, handle: 'review-handle' })
  await expect.poll(() => prepare.mock.calls.length).toBe(1)
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(replies.slice(offset).filter(value => value.status === 'failed')).toHaveLength(0)
  expect(dispose).toHaveBeenCalledTimes(1)
  expect(released).toBe(false)
  if (mode === 'cancelled') cancel()
  release()
  await expect.poll(() => released).toBe(true)
  if (mode === 'cancelled') {
    expect(replies).toHaveLength(offset)
    expect(dispose).toHaveBeenCalledTimes(1)
    return
  }
  await expect.poll(() => replies.at(-1)?.status).toBe('failed')
  const events = replies.slice(offset)
  expect(events.at(-1)).toEqual({ incarnation: 'synthetic-worker', id: 'prepare', operationId, status: 'failed', code: 'SIGNIN_MERGE_RESOURCE_LIMIT' })
  expect(events.filter(value => value.value?.resourceFailure)).toHaveLength(1)
  expect(events.find(value => value.value?.resourceFailure).value.resourceFailure).toMatchObject({ dimension: 'observationBytes', records: 2, value: SIGNIN_MERGE_LIMITS.observationBytes + 17 })
  expect(events.find(value => value.value?.codec).value.codec.encodedOutputBytes).toBeGreaterThan(0)
  expect(JSON.stringify(events)).not.toContain('synthetic private disposal failure')
  send({ kind: 'prepare', id: 'stale-prepare', operationId, handle: 'review-handle' })
  await expect.poll(() => replies.at(-1)?.id).toBe('stale-prepare')
  expect(replies.at(-1)?.code).toBe('SIGNIN_RECEIPT_MISMATCH')
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(dispose).toHaveBeenCalledTimes(1)
})
