import { expect, it } from 'vitest'
import { BUNDLED_CATALOGS } from '../catalog/bundled'
import { buildModReferences } from '../domain/build-references'
import { entityDefinitionKey } from '../domain/core'
import { createStarterLocalData, prepareModCatalogs } from '../persistence/local-data'
import { createPublicSnapshot, decodePublicSnapshot, encodePublicSnapshot, publicCatalogPin } from './public-share'
import { PublicCheckpointContextSchema } from './public-source-context-schema'
import { validatePublicSnapshot } from './public-share-schema'

it.each(['Judite', 'Marco', 'Prudence', 'Marcy'])('shares saved %s selections when historical mod mechanics are absent', async title => {
  const localData = createStarterLocalData(), catalogs = await prepareModCatalogs(localData, BUNDLED_CATALOGS)
  const build = Object.values(localData.builds).find(build => build.title === title)!, revision = localData.buildRevisions[build.latestRevisionId!]!
  const before = JSON.stringify(localData)
  const snapshot = createPublicSnapshot({ planner: { localData, catalogs } }, { kind: 'build', revisionId: revision.id }, { includeNotes: false })
  const selected = new Map(buildModReferences(revision.content).map(ref => [entityDefinitionKey(ref), ref]))
  expect(snapshot.receipts).toHaveLength(selected.size)
  for (const ref of selected.values()) {
    if (ref.kind !== 'catalog') throw new Error('Expected catalog-backed starter selections')
    const receipt = snapshot.receipts.find(receipt => receipt.ref.kind === 'catalog' && receipt.ref.entityId === ref.entityId && receipt.ref.catalogRevisionId === publicCatalogPin(localData, ref.catalogId, ref.catalogRevisionId).catalogRevisionId)!
    expect(receipt).toBeDefined()
    expect(receipt.name).toBe(revision.content.referenceNames!.find(entry => entityDefinitionKey(entry.ref) === entityDefinitionKey(ref))!.name)
    expect(receipt.kind).toBeNull()
    const saved = revision.content.referenceNames!.find(entry => entityDefinitionKey(entry.ref) === entityDefinitionKey(ref))!
    if (saved.projectId && saved.modelKey) expect(receipt.origin).toMatchObject({ projectId: saved.projectId, modelKey: saved.modelKey })
    else expect(receipt.origin).toBeNull()
  }
  expect(decodePublicSnapshot(encodePublicSnapshot(snapshot))).toEqual(snapshot)
  for (const privateField of ['rawDescription', 'StatMods', 'HPRating', 'identityMappings', 'passiveEntityIds', 'fields', 'sources']) expect(JSON.stringify(snapshot)).not.toContain(`"${privateField}"`)
  expect(JSON.stringify(localData)).toBe(before)
})

const catalogReceipt = { ref: { kind: 'catalog' as const, catalogId: 'source', catalogRevisionId: 'source-v1', entityId: 'selected' }, kind: null, name: 'Saved selection', origin: null }
const completeReceipt = { ...catalogReceipt, kind: 'class' as const, origin: { kind: 'catalog' as const, projectId: 'source', sourceRevisionId: 'source-v1', catalogId: 'source', catalogRevisionId: 'source-v1' } }
const checkpoint = { version: 1, setupDigest: 'a'.repeat(64), receipts: [completeReceipt], personalBindings: [] }

it('keeps persisted v1 receipt acceptance unchanged and admits nullable catalog receipts only under v2', () => {
  expect(PublicCheckpointContextSchema.safeParse(checkpoint).success).toBe(true)
  expect(PublicCheckpointContextSchema.safeParse({ ...checkpoint, receipts: [catalogReceipt] }).success).toBe(false)
  expect(PublicCheckpointContextSchema.safeParse({ ...checkpoint, version: 2, receipts: [catalogReceipt] }).success).toBe(true)
  // Version 1 shape admission predates semantic personal validation; widening public v5 must not rewrite its acceptance contract
  const historicalPersonal = { ...completeReceipt, ref: { kind: 'personal', fingerprint: { kind: 'personal-definition-v1', value: 'b'.repeat(64) } }, fingerprint: undefined }
  expect(PublicCheckpointContextSchema.safeParse({ ...checkpoint, receipts: [historicalPersonal] }).success).toBe(true)
  expect(PublicCheckpointContextSchema.safeParse({ ...checkpoint, version: 2, receipts: [historicalPersonal] }).success).toBe(false)
})

it('rejects incomplete personal receipts and mismatched known catalog origin in public v5', () => {
  const setup = { catalogLock: { source: 'source-v1' }, baseline: { catalogId: 'source', catalogRevisionId: 'source-v1' }, layers: [], mode: { state: 'unknown' }, ppCostsNonNegative: { state: 'unknown' }, slots: [] }
  const slot = { primaryClass: catalogReceipt.ref, secondaryClass: null, equipment: [], equipmentGroups: [], passives: [] }
  const snapshot = { version: 5, kind: 'build', title: 'Saved selection', setup, slots: [slot], receipts: [catalogReceipt] }
  expect(() => validatePublicSnapshot(snapshot)).not.toThrow()
  for (const receipt of [{ ...completeReceipt, origin: { ...completeReceipt.origin, catalogRevisionId: 'another-revision' } }, { ...catalogReceipt, fingerprint: { kind: 'personal-definition-v1', value: 'b'.repeat(64) }, ref: { kind: 'personal', fingerprint: { kind: 'personal-definition-v1', value: 'b'.repeat(64) } } }]) {
    expect(() => validatePublicSnapshot({ ...snapshot, slots: [{ ...slot, primaryClass: receipt.ref }], receipts: [receipt] })).toThrow()
  }
})

it('requires a saved display name rather than deriving one from a slot, ID or family', async () => {
  const localData = createStarterLocalData(), catalogs = await prepareModCatalogs(localData, BUNDLED_CATALOGS)
  const build = Object.values(localData.builds).find(build => build.title === 'Marco')!, revision = localData.buildRevisions[build.latestRevisionId!]!
  const primary = revision.content.primaryClass!
  const changed = { ...localData, buildRevisions: { ...localData.buildRevisions, [revision.id]: { ...revision, content: { ...revision.content, referenceNames: revision.content.referenceNames!.filter(receipt => entityDefinitionKey(receipt.ref) !== entityDefinitionKey(primary)) } } } }
  expect(() => createPublicSnapshot({ planner: { localData: changed, catalogs } }, { kind: 'build', revisionId: revision.id }, { includeNotes: false })).toThrow(/exact saved display receipt/)
})

it('requires personal kind, origin and fingerprint independently in nullable catalog receipt contexts', () => {
  const value = 'b'.repeat(64), fingerprint = { kind: 'personal-definition-v1', value }
  const personal = { ref: { kind: 'personal', fingerprint }, kind: 'item', name: 'Personal selected item', fingerprint, origin: { kind: 'personal', projectId: 'personal-definition-v1', sourceRevisionId: value, catalogId: 'personal-definition-v1', catalogRevisionId: value } }
  expect(PublicCheckpointContextSchema.safeParse({ ...checkpoint, version: 2, receipts: [personal] }).success).toBe(true)
  for (const missing of [{ kind: null }, { origin: null }, { fingerprint: undefined }]) expect(PublicCheckpointContextSchema.safeParse({ ...checkpoint, version: 2, receipts: [{ ...personal, ...missing }] }).success).toBe(false)
})
