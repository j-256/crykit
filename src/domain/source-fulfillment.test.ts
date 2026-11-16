import { checkpointContentDigest } from './checkpoint-identity'
import { createSampleLocalData } from './sample-data'
import { validateNativeLocalDataGraph } from '../interchange/native'
import { expect, it } from 'vitest'
import { previewCrystalEdit } from '../interchange/crystal-edit'
import { fulfillSource, sourcePayloadValid } from './source-fulfillment'
import type { CatalogId, CatalogRevisionId } from './types'
import { artifactSuppliesCatalog } from './source-artifacts'
import { CURRENT_CATALOG } from '../catalog/bundled'

const imported = async () => (await previewCrystalEdit(new TextEncoder().encode(JSON.stringify({ ID: 'Synthetic bundled source', EditorVersion: 34, Equipment: [{ ID: 3, Name: 'Synthetic Dirk' }] })), 'private-original.json')).proposed.catalogs[0]!

it('fulfills exact requests across origins without rewriting payload citations or requested identity', async () => {
  const original = await imported()
  const pin = { id: 'crystal-project/mod/synthetic-dirk' as CatalogId, revisionId: 'v1' as CatalogRevisionId, checksum: original.checksum, payloadSource: { catalogId: original.id, catalogRevisionId: original.revisionId } }
  const bundled = { ...original, ...pin }
  const before = JSON.stringify(bundled)
  const requested = { catalogId: original.id, catalogRevisionId: original.revisionId }
  const result = fulfillSource(requested, [bundled], [pin])!
  expect(result.catalog).toEqual(original)
  expect(result.suppliedBy).toEqual({ catalogId: bundled.id, catalogRevisionId: bundled.revisionId })
  expect(JSON.stringify(bundled)).toBe(before)
  expect(fulfillSource({ catalogId: bundled.id, catalogRevisionId: bundled.revisionId }, [original], [pin])?.catalog).toEqual(bundled)
  expect(result.catalog.entities).toBe(bundled.entities)
  expect(artifactSuppliesCatalog({}, result.catalog)).toBe(false)
})

it('checks current packaged payloads and never reuses a shallow-frozen validation result', async () => {
  expect(sourcePayloadValid(CURRENT_CATALOG)).toBe(true)
  expect(sourcePayloadValid(CURRENT_CATALOG)).toBe(true)
  const catalog = await imported()
  const mutable = { ...structuredClone(catalog.entities) }
  const shallow = Object.freeze({ ...catalog, entities: mutable })
  expect(sourcePayloadValid(shallow)).toBe(true)
  const entity = Object.values(mutable)[0]!
  mutable[entity.id] = { ...entity, name: 'Changed after validation' }
  expect(sourcePayloadValid(shallow)).toBe(false)
})

it('requires a trusted bundled receipt, exact interpretation, and verified complete payload', async () => {
  const original = await imported()
  const pin = { id: 'crystal-project/mod/synthetic-dirk' as CatalogId, revisionId: 'v1' as CatalogRevisionId, checksum: original.checksum, payloadSource: { catalogId: original.id, catalogRevisionId: original.revisionId } }
  const bundled = { ...original, ...pin }
  const requested = { catalogId: original.id, catalogRevisionId: original.revisionId }
  expect(fulfillSource(requested, [bundled], [])).toBeUndefined()
  expect(fulfillSource(requested, [{ ...bundled, payloadSource: { ...pin.payloadSource, catalogRevisionId: original.revisionId.replace(/p[0-9]+$/, 'p999') as CatalogRevisionId } }], [pin])).toBeUndefined()
  const entity = Object.values(original.entities)[0]!
  const forged = { ...bundled, entities: { [entity.id]: { ...entity, name: 'Forged record' } } }
  expect(sourcePayloadValid(forged, [pin])).toBe(false)
  expect(fulfillSource(requested, [forged], [pin])).toBeUndefined()
  expect(fulfillSource({ catalogId: pin.id, catalogRevisionId: pin.revisionId }, [original], [{ ...pin, checksum: 'payload:sha256:' + '0'.repeat(64) }])).toBeUndefined()
})

it('admits complete retained source bodies without packaging historical receipts or retargeting missing references', () => {
  const { checksum: _checksum, ...current } = CURRENT_CATALOG
  const content = { ...current, revisionId: 'v1' as CatalogRevisionId }
  const retired = { ...content, checksum: `builtin:sha256:${checkpointContentDigest(content)}` }
  expect(sourcePayloadValid(retired, [])).toBe(true)
  const personal = createSampleLocalData(retired)
  const before = JSON.stringify(personal)
  expect(() => validateNativeLocalDataGraph(personal, [retired])).not.toThrow()
  expect(JSON.stringify(personal)).toBe(before)
  expect(fulfillSource({ catalogId: retired.id, catalogRevisionId: retired.revisionId }, [])).toBeUndefined()
  expect(fulfillSource({ catalogId: retired.id, catalogRevisionId: retired.revisionId }, [CURRENT_CATALOG])).toBeUndefined()
  expect(fulfillSource({ catalogId: retired.id, catalogRevisionId: retired.revisionId }, [retired])?.catalog).toBe(retired)
  const entity = Object.values(retired.entities)[0]!
  expect(sourcePayloadValid({ ...retired, entities: { ...retired.entities, [entity.id]: { ...entity, name: 'Altered after capture' } } }, [])).toBe(false)
  expect(sourcePayloadValid({ ...retired, checksum: 'builtin:sha256:' + '0'.repeat(64) }, [])).toBe(false)
  expect(sourcePayloadValid(retired, [{ id: retired.id, revisionId: retired.revisionId, checksum: 'builtin:sha256:' + '0'.repeat(64) }])).toBe(false)
})
