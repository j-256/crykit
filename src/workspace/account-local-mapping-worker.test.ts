import { afterEach, expect, it, vi } from 'vitest'
import { encodeBackupJson } from '../interchange/workspace-backup-json'

const mocks = vi.hoisted(() => ({ baseline: vi.fn(), map: vi.fn() }))
vi.mock('./account-local-mapping', () => ({ prepareIncrementalBaseline: mocks.baseline, prepareIncrementalMapping: mocks.map }))
vi.mock('../persistence/account-database', () => ({ AccountDatabase: class { close() {} } }))
vi.mock('../account/profile', () => ({ installProfile: () => ({}), invalidateProfile() {}, assertActiveProfile() {} }))
vi.mock('../account/background-work', () => ({ installAccountWorkCheckpoint() {} }))
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks() })

it('reports each reused mapping request and its failure before the terminal reply only when opted in', async () => {
  const replies: any[] = []
  const realm = { onmessage: undefined as ((event: MessageEvent) => void) | undefined, postMessage: (value: unknown) => replies.push(structuredClone(value)) }
  vi.stubGlobal('self', realm)
  await import('./account-local-mapping-worker')
  const send = (value: object) => realm.onmessage!({ data: { incarnation: 'synthetic-worker', ...value } } as MessageEvent)
  send({ kind: 'initialize', accountId: 'synthetic-account', key: new Uint8Array(32) })
  const bytes = [...encodeBackupJson({ synthetic: true })].reduce((sum, page) => sum + page.length, 0)
  mocks.baseline.mockImplementation(async () => { [...encodeBackupJson({ synthetic: true })]; return 'ticket' })
  mocks.map.mockImplementation(async () => { [...encodeBackupJson({ synthetic: true })]; throw new Error('private failure') })
  send({ kind: 'baseline', id: 'first', fence: {}, diagnostics: true })
  await expect.poll(() => replies.length).toBe(2)
  expect(replies).toEqual([
    { incarnation: 'synthetic-worker', id: 'first', status: 'progress', value: { codec: { encodedOutputBytes: bytes } } },
    { incarnation: 'synthetic-worker', id: 'first', status: 'complete', value: 'ticket' },
  ])
  send({ kind: 'map', id: 'second', row: {}, diagnostics: true })
  await expect.poll(() => replies.length).toBe(4)
  expect(replies[2]).toMatchObject({ id: 'second', status: 'progress', value: { codec: { encodedOutputBytes: bytes } } })
  expect(replies[3]).toEqual({ incarnation: 'synthetic-worker', id: 'second', status: 'failed' })
  send({ kind: 'baseline', id: 'unobserved', fence: {} })
  await expect.poll(() => replies.length).toBe(5)
  expect(replies[4]).toEqual({ incarnation: 'synthetic-worker', id: 'unobserved', status: 'complete', value: 'ticket' })
  expect(JSON.stringify(replies)).not.toContain('private failure')
})
