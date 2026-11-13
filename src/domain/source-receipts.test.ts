import { expect, it, vi } from 'vitest'
import { previewCrystalEdit } from '../interchange/crystal-edit'
import { assertModSourceReceipts } from './build-reference-names'
import { SOURCE_REVISION_RECEIPTS } from '../catalog/source-revisions'
import type { CatalogSnapshot, GameSetupRevision } from './types'

vi.mock('../catalog/source-revisions', async importOriginal => {
  const actual = await importOriginal<typeof import('../catalog/source-revisions')>()
  return { ...actual, SOURCE_REVISION_RECEIPTS: [...actual.SOURCE_REVISION_RECEIPTS] }
})
function setup(source: CatalogSnapshot, contentFingerprint: string): Pick<GameSetupRevision, 'modComposition' | 'modSourceReceipts'> {
  const pin = { catalogId: source.id, catalogRevisionId: source.revisionId }
  return { modComposition: { baseline: { catalogId: 'crystal-project/vanilla' as never, catalogRevisionId: 'v1' as never }, layers: [{ ...pin, enabled: true }], links: [] }, modSourceReceipts: [{ ...pin, checksum: source.checksum, title: 'Synthetic receipt', contentFingerprint }] }
}
it('admits exact imported and trusted bundled receipts while rejecting prelaunch or changed identities', async () => {
  const source = (await previewCrystalEdit(new TextEncoder().encode('{"ID":"Synthetic receipt","EditorVersion":34,"Items":[]}'), 'synthetic.json')).proposed.catalogs[0]!
  const fingerprint = (source.legacy as Record<string, string>).contentFingerprint
  expect(() => assertModSourceReceipts(setup(source, fingerprint))).not.toThrow()
  expect(() => assertModSourceReceipts(setup(source, `json-content-v1:sha256:${'0'.repeat(64)}`))).toThrow()
  const checksum = `sha256:${'0'.repeat(64)}`
  const prelaunch = { ...source, id: 'crystal-edit:old' as never, revisionId: `${checksum}:rules-v1:library-v1` as never, checksum }
  expect(() => assertModSourceReceipts(setup(prelaunch, fingerprint))).toThrow()
  const bundled = { ...source, id: 'crystal-project/mod/synthetic' as never, revisionId: 'v1' as never }
  expect(() => assertModSourceReceipts(setup(bundled, fingerprint))).toThrow()
  const registry = SOURCE_REVISION_RECEIPTS as Array<typeof SOURCE_REVISION_RECEIPTS[number]>
  registry.push({ id: bundled.id, revisionId: bundled.revisionId, checksum: bundled.checksum, payloadSource: { catalogId: source.id, catalogRevisionId: source.revisionId } })
  try {
    expect(() => assertModSourceReceipts(setup(bundled, fingerprint))).not.toThrow()
    expect(() => assertModSourceReceipts(setup({ ...bundled, checksum: `payload:sha256:${'0'.repeat(64)}` }, fingerprint))).toThrow()
  } finally { registry.pop() }
})
