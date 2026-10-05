import { expect, it } from 'vitest'
import { BUNDLED_CATALOG, CURRENT_CATALOG } from './bundled'
import { bundledModIdentity } from '../domain/bundled-mods'
import { nativeIdentity, nativeSourceRecord } from '../domain/native-game'
import { nativeDescription } from './native-description'
import { nativeEquipmentFacts } from './native-equipment-facts'
import { nativeFieldFacts } from './native-field-facts'
import { nativeGardening } from './native-gardening'
import { NATIVE_REFERENCE_LINKS, preferredNativeReferenceId } from './native-reference-links'
import { projectAcquisitionGuidance } from './acquisition-guidance'
import { catalogContentForChecksum } from '../interchange/catalog-checksum'
import { sha256 } from '../interchange/util'

it('pins an independently assembled native base without source-backed mods or dated innate overrides', async () => {
  expect(CURRENT_CATALOG.revisionId).not.toBe(BUNDLED_CATALOG.revisionId)
  const { checksum: _checksum, ...content } = CURRENT_CATALOG
  expect(CURRENT_CATALOG.checksum).toBe(`builtin:sha256:${await sha256(new TextEncoder().encode(catalogContentForChecksum(content)))}`)
  for (const entity of Object.values(CURRENT_CATALOG.entities)) {
    expect(bundledModIdentity(entity)).toBeUndefined()
    expect(Object.keys(entity.fields).some(key => key.startsWith('Learnable Innate Skill'))).toBe(false)
    if (nativeIdentity(entity)?.database === 'passive' && typeof nativeSourceRecord(entity)?.PP === 'number') expect(entity.ppCost).toMatchObject({ state: 'known', value: nativeSourceRecord(entity)!.PP })
  }
  expect(Object.values(CURRENT_CATALOG.entities).some(entity => entity.name === 'Doge Shield')).toBe(true)
  expect(CURRENT_CATALOG.entities['mod:equipment-expansion:equipment:592']).toBeUndefined()
  expect(BUNDLED_CATALOG.entities['mod:equipment-expansion:equipment:592']).toBeDefined()
})

it('retains fingerprint-backed presentation for the new base and rejects altered snapshots', () => {
  const equipment = Object.values(CURRENT_CATALOG.entities).find(entity => nativeIdentity(entity)?.database === 'equipment' && nativeIdentity(entity)?.mode === 'base')!
  expect(nativeDescription(equipment)).toBeDefined()
  expect(nativeEquipmentFacts(CURRENT_CATALOG, equipment)).toBeDefined()
  expect(nativeFieldFacts(CURRENT_CATALOG, equipment).length).toBeGreaterThan(0)
  expect(nativeEquipmentFacts({ ...CURRENT_CATALOG, checksum: 'synthetic-unreviewed' }, equipment)).toBeUndefined()
  expect(nativeDescription({ ...equipment, name: 'Synthetic altered equipment' })).toBeUndefined()
  const seed = Object.values(CURRENT_CATALOG.entities).find(entity => nativeGardening(CURRENT_CATALOG, entity))!
  expect(seed).toBeDefined()
  const berries = CURRENT_CATALOG.entities['base:item:203']!
  expect(projectAcquisitionGuidance(CURRENT_CATALOG, berries).acquisition.routes.length).toBeGreaterThan(0)
  const linked = NATIVE_REFERENCE_LINKS.links.find(link => link.relation === 'same-definition' && preferredNativeReferenceId(CURRENT_CATALOG, link.sourceId))!
  expect(linked).toBeDefined()
  expect(preferredNativeReferenceId({ ...CURRENT_CATALOG, checksum: 'synthetic-unreviewed' }, linked.sourceId)).toBeUndefined()
})
