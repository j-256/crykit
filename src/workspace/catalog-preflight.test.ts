import { afterEach, expect, it, vi } from 'vitest'
import { hashBlob } from './blobs'
import { workspaceDocumentSource } from './document-codec'
import type { JsonValue } from '../domain/types'
import { GUIDE_CATALOG } from '../catalog/bundled'
import { immutableCatalogSnapshot } from '../interchange/native'
import { checkpointContentDigest, checkpointContentDigestAsync } from '../domain/checkpoint-identity'
import { prepareSourcePayloadValidation, sourcePayloadValid } from '../domain/source-fulfillment'
import { prepareCatalogPayload, encodeCatalogPayload, decodeCatalogPayload } from './catalog-codec'

const fresh = () => immutableCatalogSnapshot(structuredClone(GUIDE_CATALOG))
afterEach(() => vi.restoreAllMocks())
it.each([null, { z: ['é', '\ud800', null, -0, 1.25], a: { y: undefined, x: true } }, GUIDE_CATALOG])('preserves canonical synchronous digest bytes for async preparation %#', async value => {
  expect(await checkpointContentDigestAsync(value, () => {})).toBe(checkpointContentDigest(value))
})
it('validates the complete immutable source before exact-byte compressed preparation', async () => {
  const catalog = fresh(), peer = fresh(), expected = encodeCatalogPayload(peer), check = vi.fn()
  let taskRan = false
  setTimeout(() => { taskRan = true }, 0)
  expect(await prepareSourcePayloadValidation(catalog, check)).toBe(true)
  const encoded = await prepareCatalogPayload(catalog, check)
  expect(taskRan).toBe(true)
  expect(check.mock.calls.length).toBeGreaterThan(4)
  expect(sourcePayloadValid(catalog)).toBe(true)
  expect(sourcePayloadValid(catalog, [])).toBe(false)
  expect(JSON.stringify(encoded)).toBe(JSON.stringify(expected))
  const frame = (value: typeof catalog) => workspaceDocumentSource({ version: 1, kind: 'catalog', key: 'synthetic-catalog', value: value as unknown as JsonValue })
  expect(await hashBlob(frame(catalog))).toBe(await hashBlob(frame(peer)))
  expect(encodeCatalogPayload(catalog)).toBe(encoded)
  expect(decodeCatalogPayload(encoded)).toEqual(catalog)
  expect(() => decodeCatalogPayload({ ...encoded, pages: [...encoded.pages, '!!!!'] })).toThrow()
})
it.each(['mutable', 'shallow', 'checksum', 'receipt', 'contents'] as const)('rejects %s source authority without trusting a claimed checksum', async mode => {
  const catalog = structuredClone(GUIDE_CATALOG)
  if (mode === 'shallow') Object.freeze(catalog)
  else if (mode !== 'mutable') {
    if (mode === 'checksum') Object.assign(catalog, { checksum: 'builtin:sha256:' + '0'.repeat(64) })
    if (mode === 'receipt') Object.assign(catalog, { revisionId: 'v999' })
    if (mode === 'contents') {
      const entity = Object.values(catalog.entities)[0]!
      Object.assign(catalog, { entities: { ...catalog.entities, [entity.id]: { ...entity, name: 'Changed source payload' } } })
    }
    immutableCatalogSnapshot(catalog)
  }
  if (mode === 'mutable' || mode === 'shallow') {
    await expect(prepareSourcePayloadValidation(catalog, () => {})).rejects.toThrow('immutable')
    await expect(prepareCatalogPayload(catalog, () => {})).rejects.toThrow('immutable')
  } else expect(await prepareSourcePayloadValidation(catalog, () => {})).toBe(false)
})
it.each(['validation', 'compression'] as const)('rejects mid-yield cancellation during %s and does not publish partial cache success', async phase => {
  const catalog = fresh(), controller = new AbortController(), check = () => controller.signal.throwIfAborted()
  setTimeout(() => controller.abort(new Error('synthetic cancellation')), 0)
  const prepare = phase === 'validation' ? prepareSourcePayloadValidation : prepareCatalogPayload
  await expect(prepare(catalog, check)).rejects.toThrow('synthetic cancellation')
  const codec = await import('../interchange/workspace-backup-compression')
  const encode = vi.spyOn(codec, 'encodeBackupPage')
  const digest = vi.spyOn(crypto.subtle, 'digest')
  if (phase === 'validation') { expect(await prepareSourcePayloadValidation(catalog, () => {})).toBe(true); expect(digest).toHaveBeenCalled() }
  else { await prepareCatalogPayload(catalog, () => {}); expect(encode).toHaveBeenCalled() }
})
it('does not cache WebCrypto rejection as source validity', async () => {
  const catalog = fresh(), digest = vi.spyOn(crypto.subtle, 'digest').mockRejectedValueOnce(new Error('synthetic digest failure'))
  await expect(prepareSourcePayloadValidation(catalog, () => {})).rejects.toThrow('synthetic digest failure')
  expect(await prepareSourcePayloadValidation(catalog, () => {})).toBe(true)
  expect(digest).toHaveBeenCalledTimes(2)
})

it.each(['hash-complete', 'last-page'] as const)('checks late ownership loss after %s before admitting a cached result', async phase => {
  const catalog = fresh(), controller = new AbortController(), check = () => controller.signal.throwIfAborted()
  if (phase === 'hash-complete') {
    const digest = crypto.subtle.digest.bind(crypto.subtle)
    const observed = vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (...args) => { const result = await digest(...args); controller.abort(new Error('late ownership loss')); return result })
    await expect(prepareSourcePayloadValidation(catalog, check)).rejects.toThrow('late ownership loss')
    expect(await prepareSourcePayloadValidation(catalog, () => {})).toBe(true)
    expect(observed).toHaveBeenCalledTimes(2)
  } else {
    const codec = await import('../interchange/workspace-backup-compression'), encode = codec.encodeBackupPage
    const observed = vi.spyOn(codec, 'encodeBackupPage').mockImplementationOnce(bytes => { const result = encode(bytes); controller.abort(new Error('late ownership loss')); return result })
    await expect(prepareCatalogPayload(catalog, check)).rejects.toThrow('late ownership loss')
    const before = observed.mock.calls.length
    await prepareCatalogPayload(catalog, () => {})
    expect(observed.mock.calls.length).toBeGreaterThan(before)
  }
})
