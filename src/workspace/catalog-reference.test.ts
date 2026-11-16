import { expect, it } from 'vitest'
import { CURRENT_CATALOG } from '../catalog/bundled'
import { privateRecordKey } from './documents'
import { workspaceDocumentSource } from './document-codec'
import { hashBlob, readBlob } from './blobs'
import { ownCatalogRegistry, resolveRetainedCatalog } from './catalog-reference'

async function fixture() {
  const catalog = CURRENT_CATALOG
  const content = workspaceDocumentSource({ version: 1, kind: 'catalog', key: privateRecordKey('catalog', catalog.id, catalog.revisionId), value: catalog as never })
  const body = { documentId: 'retained-frame', revisionId: 'revision', byteLength: content.byteLength, sha256: await hashBlob(content), encoding: 'bytes' as const }
  const reference = { version: 1 as const, kind: 'retained-catalog-reference' as const, catalogId: catalog.id, catalogRevisionId: catalog.revisionId, checksum: catalog.checksum, schemaVersion: catalog.schemaVersion, body, codec: 'catalog-document-v1' as const }
  return { catalog, content, body, reference }
}

it('authenticates the retained frame before reusing the exact packaged catalog', async () => {
  const f = await fixture()
  let live = true, consumed = false
  const registry = ownCatalogRegistry([{ ref: f.body, content: { byteLength: f.content.byteLength, async *open() { yield* f.content.open(); consumed = true } } }], async () => { if (!live) throw new Error('revoked') })
  const resolved = await resolveRetainedCatalog(f.reference, registry)
  expect(consumed).toBe(true)
  expect(resolved.snapshot).toBe(f.catalog)
  expect(await hashBlob(resolved.body.content)).toBe(f.body.sha256)
  live = false
  await expect(readBlob(resolved.body.content, f.body.byteLength)).rejects.toThrow('revoked')
  await expect(resolveRetainedCatalog(f.reference, registry)).rejects.toThrow('revoked')
})

it('rejects missing fallbacks even when the exact bundle is installed', async () => {
  const f = await fixture()
  await expect(resolveRetainedCatalog(f.reference, ownCatalogRegistry([], async () => {}))).rejects.toThrow()
})

it('rejects final authentication failure before exposing a packaged singleton', async () => {
  const f = await fixture()
  const content = { byteLength: f.content.byteLength, async *open() { yield* f.content.open(); throw new Error('final authentication tag') } }
  await expect(resolveRetainedCatalog(f.reference, ownCatalogRegistry([{ ref: f.body, content }], async () => {}))).rejects.toThrow('final authentication tag')
})

it('binds every reference field and rejects lookalike registry capabilities', async () => {
  const f = await fixture(), registry = ownCatalogRegistry([{ ref: f.body, content: f.content }], async () => {})
  for (const patch of [{ codec: 'unknown' }, { schemaVersion: 'wrong' }, { checksum: 'wrong' }, { catalogRevisionId: 'wrong' }, { body: { ...f.body, sha256: '0'.repeat(64) } }, { body: { ...f.body, byteLength: f.body.byteLength + 1 } }, { body: { ...f.body, encoding: 'utf8' } }]) {
    await expect(resolveRetainedCatalog({ ...f.reference, ...patch }, registry)).rejects.toThrow()
  }
  await expect(resolveRetainedCatalog(f.reference, {} as never)).rejects.toThrow()
  expect(() => ownCatalogRegistry([{ ref: f.body, content: f.content }, { ref: f.body, content: f.content }], async () => {})).toThrow()
})

it('rejects authenticated frames with foreign keys, malformed pages, expanded overflow, or changed contents under the same pins', async () => {
  const { GUIDE_CATALOG } = await import('../catalog/bundled')
  const { encodeCatalogPayload } = await import('./catalog-codec')
  const { encodeBackupPage } = await import('../interchange/workspace-backup-compression')
  const { maxDocumentBytes } = await import('../account/protocol')
  const { memoryBlob } = await import('./blobs')
  const catalog = GUIDE_CATALOG, encoded = encodeCatalogPayload(catalog)
  const key = privateRecordKey('catalog', catalog.id, catalog.revisionId)
  const frame = (value: unknown, frameKey: string) => {
    const payload = new TextEncoder().encode(JSON.stringify(value)), metadata = new TextEncoder().encode(JSON.stringify({ version: 1, kind: 'catalog', key: frameKey, encoding: 'json', byteLength: payload.length }))
    const magic = new TextEncoder().encode('CRYKIT-DOC/1\n'), length = new Uint8Array(4)
    new DataView(length.buffer).setUint32(0, metadata.length, true)
    const bytes = new Uint8Array(magic.length + length.length + metadata.length + payload.length)
    bytes.set(magic); bytes.set(length, magic.length); bytes.set(metadata, magic.length + length.length); bytes.set(payload, magic.length + length.length + metadata.length)
    return memoryBlob(bytes)
  }
  const changed = new TextEncoder().encode(JSON.stringify({ ...catalog, importedAt: '2026-11-16T00:00:00.000Z' }))
  const changedPayload = { ...encoded, byteLength: changed.length, pages: [Buffer.from(encodeBackupPage(changed)).toString('base64')] }
  const variants = [[encoded, 'foreign-key'], [{ ...encoded, byteLength: maxDocumentBytes + 1 }, key], [{ ...encoded, pages: ['AB=='] }, key], [changedPayload, key], [catalog, key]] as const
  for (const [payload, frameKey] of variants) {
    const content = frame(payload, frameKey), body = { documentId: 'body', revisionId: 'revision', byteLength: content.byteLength, sha256: await hashBlob(content), encoding: 'bytes' as const }
    const reference = { version: 1, kind: 'retained-catalog-reference', catalogId: catalog.id, catalogRevisionId: catalog.revisionId, checksum: catalog.checksum, schemaVersion: catalog.schemaVersion, codec: 'catalog-document-v1', body }
    await expect(resolveRetainedCatalog(reference, ownCatalogRegistry([{ ref: body, content }], async () => {}))).rejects.toThrow()
  }
})

it('charges inline and referenced catalog expansion before inflation and accepts the exact aggregate boundary', async () => {
  const { catalogExpansionBudget, MAX_EXPANDED_SNAPSHOT_CATALOG_BYTES } = await import('./catalog-reference')
  const { decodeCatalogPayload } = await import('./catalog-codec')
  const compression = await import('../interchange/workspace-backup-compression')
  const { vi } = await import('vitest')
  const exact = catalogExpansionBudget()
  expect(() => exact.reserve(MAX_EXPANDED_SNAPSHOT_CATALOG_BYTES)).not.toThrow()
  expect(() => exact.reserve(1)).toThrow(/budget/)
  const budget = catalogExpansionBudget()
  budget.inline({ kind: 'synthetic-inline-contribution' })
  // Only the canonical envelope is needed: aggregate refusal precedes inflation of its bounded synthetic pages
  const envelope = { version: 1, kind: 'compressed-catalog-snapshot', encoding: 'deflate-json-pages-v1', byteLength: MAX_EXPANDED_SNAPSHOT_CATALOG_BYTES, pages: Array.from({ length: MAX_EXPANDED_SNAPSHOT_CATALOG_BYTES / (1024 * 1024) }, () => 'AAAA') }
  const inflate = vi.spyOn(compression, 'decodeBackupPage')
  try {
    expect(() => decodeCatalogPayload(envelope, budget.reserve)).toThrow(/budget/)
    expect(inflate).not.toHaveBeenCalled()
  } finally { inflate.mockRestore() }
})

it('rejects saved-byte digest changes and ownership loss during the authenticated read', async () => {
  const f = await fixture(), wrong = { ...f.body, sha256: '0'.repeat(64) }
  await expect(resolveRetainedCatalog({ ...f.reference, body: wrong }, ownCatalogRegistry([{ ref: wrong, content: f.content }], async () => {}))).rejects.toThrow(/digest/)
  let live = true
  const content = { byteLength: f.content.byteLength, async *open() { yield* f.content.open(); live = false } }
  await expect(resolveRetainedCatalog(f.reference, ownCatalogRegistry([{ ref: f.body, content }], async () => { if (!live) throw new Error('owner changed') }))).rejects.toThrow('owner changed')
})
