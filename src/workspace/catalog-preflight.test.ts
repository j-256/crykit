import { afterEach, expect, it, vi } from 'vitest'
import { hashBlob } from './blobs'
import { workspaceDocumentSource } from './document-codec'
import type { JsonValue } from '../domain/types'
import { CURRENT_CATALOG } from '../catalog/bundled'
import { SYNTHETIC_RETAINED_CATALOG } from '../domain/retained-catalog.test-helpers'
import { immutableCatalogSnapshot } from '../interchange/native'
import { checkpointContentDigest, checkpointContentDigestAsync } from '../domain/checkpoint-identity'
import { prepareSourcePayloadValidation, sourcePayloadValid } from '../domain/source-fulfillment'
import { prepareCatalogPayload, encodeCatalogPayload, decodeCatalogPayload } from './catalog-codec'

const fresh = () => immutableCatalogSnapshot(structuredClone(SYNTHETIC_RETAINED_CATALOG))
afterEach(() => vi.restoreAllMocks())
it.each([null, { z: ['é', '\ud800', null, -0, 1.25], a: { y: undefined, x: true } }, SYNTHETIC_RETAINED_CATALOG, CURRENT_CATALOG])('preserves canonical synchronous digest bytes for async preparation %#', async value => {
  expect(await checkpointContentDigestAsync(value, () => {})).toBe(checkpointContentDigest(value))
})
it('snapshots nested JSON before yielding and separates serialization, encoding, and hashing into tasks', async () => {
  const value = { z: ['é', '\ud800', null, -0, 1.25], a: { y: undefined, x: true } }
  const serialized = '{"a":{"x":true},"z":["é","\\ud800",null,0,1.25]}'
  const expectedBytes = new Uint8Array([123,34,97,34,58,123,34,120,34,58,116,114,117,101,125,44,34,122,34,58,91,34,195,169,34,44,34,92,117,100,56,48,48,34,44,110,117,108,108,44,48,44,49,46,50,53,93,125])
  const expectedDigest = checkpointContentDigest(value)
  const stringify = vi.spyOn(JSON, 'stringify'), encode = vi.spyOn(TextEncoder.prototype, 'encode'), digest = vi.spyOn(crypto.subtle, 'digest')
  const result = checkpointContentDigestAsync(value, () => {})
  try {
    expect(stringify).not.toHaveBeenCalled()
    expect(encode).not.toHaveBeenCalled()
    value.a.x = false
    value.z.splice(0, value.z.length, 'changed after capture')
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(stringify.mock.results[0]?.value).toBe(serialized)
    expect(encode).not.toHaveBeenCalled()
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(encode.mock.results[0]?.value).toEqual(expectedBytes)
    expect(digest).not.toHaveBeenCalled()
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(await result).toBe(expectedDigest)
    expect(digest.mock.calls[0]).toEqual(['SHA-256', expectedBytes])
  } finally { await result }
})
it.each(['canonical-copy', 'serialization', 'UTF8-encoding'] as const)('rejects cancellation after %s without hashing or admitting source validity', async boundary => {
  const catalog = fresh(), controller = new AbortController(), digest = vi.spyOn(crypto.subtle, 'digest')
  const result = prepareSourcePayloadValidation(catalog, () => controller.signal.throwIfAborted())
  const rejected = expect(result).rejects.toThrow('cancelled between digest stages')
  // The source validator has its own initial task before the digest captures its private snapshot
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  for (let index = 0; index < ['canonical-copy', 'serialization', 'UTF8-encoding'].indexOf(boundary); index++) await new Promise<void>(resolve => setTimeout(resolve, 0))
  controller.abort(new Error('cancelled between digest stages'))
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  await rejected
  expect(digest).not.toHaveBeenCalled()
  expect(await prepareSourcePayloadValidation(catalog, () => {})).toBe(true)
  expect(digest).toHaveBeenCalledTimes(1)
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
  expect(sourcePayloadValid(catalog, [])).toBe(true)
  expect(sourcePayloadValid(catalog, [{ id: catalog.id, revisionId: catalog.revisionId, checksum: 'builtin:sha256:' + '0'.repeat(64) }])).toBe(false)
  expect(JSON.stringify(encoded)).toBe(JSON.stringify(expected))
  const frame = (value: typeof catalog) => workspaceDocumentSource({ version: 1, kind: 'catalog', key: 'synthetic-catalog', value: value as unknown as JsonValue })
  expect(await hashBlob(frame(catalog))).toBe(await hashBlob(frame(peer)))
  expect(encodeCatalogPayload(catalog)).toBe(encoded)
  expect(decodeCatalogPayload(encoded)).toEqual(catalog)
  expect(() => decodeCatalogPayload({ ...encoded, pages: [...encoded.pages, '!!!!'] })).toThrow()
})
it.each(['mutable', 'shallow', 'checksum', 'stale-revision', 'contents'] as const)('rejects %s source authority without trusting a claimed checksum', async mode => {
  const catalog = structuredClone(SYNTHETIC_RETAINED_CATALOG)
  if (mode === 'shallow') Object.freeze(catalog)
  else if (mode !== 'mutable') {
    if (mode === 'checksum') Object.assign(catalog, { checksum: 'builtin:sha256:' + '0'.repeat(64) })
    if (mode === 'stale-revision') Object.assign(catalog, { revisionId: 'v999' })
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

it.each(['retained', 'packaged-mismatch', 'untrusted-mod'] as const)('keeps synchronous and async source authority identical for %s', async mode => {
  const { checksum: _checksum, ...original } = SYNTHETIC_RETAINED_CATALOG
  const content = mode === 'packaged-mismatch' ? { ...original, id: CURRENT_CATALOG.id, revisionId: CURRENT_CATALOG.revisionId }
    : mode === 'untrusted-mod' ? { ...original, id: 'crystal-project/mod/synthetic-untrusted' as typeof original.id } : original
  const catalog = immutableCatalogSnapshot({ ...content, checksum: `builtin:sha256:${checkpointContentDigest(content)}` })
  const valid = mode === 'retained'
  expect(sourcePayloadValid(catalog)).toBe(valid)
  expect(await prepareSourcePayloadValidation(immutableCatalogSnapshot(structuredClone(catalog)), () => {})).toBe(valid)
})
