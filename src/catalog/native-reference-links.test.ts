import { describe, expect, it } from 'vitest'
import { BUNDLED_CATALOG } from './bundled'
import { NATIVE_GAME_DATA } from './native-game'
import { NATIVE_REFERENCE_LINKS, nativeReferenceAlternatives, nativeReferenceDisposition, nativeReferenceLink, preferredNativeReferenceId, validateNativeReferenceLinks, type NativeReferenceLinksManifest } from './native-reference-links'
import type { CatalogEntity, CatalogSnapshot, JsonValue } from '../domain/types'
import { nativeSourceRecord, type NativeGameSnapshot } from '../domain/native-game'

function changedEntity(entityId: string, update: Partial<CatalogEntity>): CatalogSnapshot {
  return { ...BUNDLED_CATALOG, entities: { ...BUNDLED_CATALOG.entities, [entityId]: { ...BUNDLED_CATALOG.entities[entityId]!, ...update } } }
}

describe('reviewed native reference links', () => {
  it('links reviewed source definitions while leaving their immutable identities and content intact', () => {
    const entities = BUNDLED_CATALOG.entities
    const source = entities['base:passive:ref-939']!
    const serialized = JSON.stringify(source)
    expect(preferredNativeReferenceId(BUNDLED_CATALOG, source.id)).toBe('base:passive:58')
    expect(preferredNativeReferenceId(BUNDLED_CATALOG, 'base:passive:ref-939')).toBe('base:passive:58')
    expect(preferredNativeReferenceId(BUNDLED_CATALOG, 'base:item:ref-91')).toBe('base:item:74')
    expect(preferredNativeReferenceId(BUNDLED_CATALOG, 'base:recipe:ref-933')).toBe('base:recipe:36')
    expect(preferredNativeReferenceId(BUNDLED_CATALOG, 'base:recipe:ref-934')).toBe('base:recipe:0')
    expect(preferredNativeReferenceId(BUNDLED_CATALOG, 'base:monster:ref-849')).toBe('base:monster:2')
    expect(preferredNativeReferenceId(BUNDLED_CATALOG, 'base:status:ref-951')).toBe('base:status:91')
    expect(BUNDLED_CATALOG.entities).toBe(entities)
    expect(JSON.stringify(source)).toBe(serialized)
    expect(() => validateNativeReferenceLinks(NATIVE_REFERENCE_LINKS)).not.toThrow()
  })

  it('relates a command to its native class without claiming they are the same definition', () => {
    expect(nativeReferenceLink(BUNDLED_CATALOG, 'base:command:ref-28')).toMatchObject({ targetId: 'base:job:0', relation: 'command-of-class', review: 'class-command' })
    expect(preferredNativeReferenceId(BUNDLED_CATALOG, 'base:command:ref-28')).toBeUndefined()
    expect(nativeReferenceAlternatives(BUNDLED_CATALOG, 'base:job:0')).toEqual([nativeReferenceLink(BUNDLED_CATALOG, 'base:command:ref-28')])
  })

  it('retains unresolved identities, mod scopes, and conflicting variants for review', () => {
    expect(nativeReferenceLink(BUNDLED_CATALOG, 'mod:additional-boss-pinga:monster:ref-1066')).toBeUndefined()
    expect(nativeReferenceDisposition(BUNDLED_CATALOG, 'mod:additional-boss-pinga:monster:ref-1066')).toBe('mod-source-review')
    expect(nativeReferenceLink(BUNDLED_CATALOG, 'base:monster:ref-795')).toBeUndefined()
    expect(nativeReferenceDisposition(BUNDLED_CATALOG, 'base:monster:ref-795')).toBe('native-identity-review')
    expect(nativeReferenceLink(BUNDLED_CATALOG, 'base:status:ref-965')).toBeUndefined()
    expect(nativeReferenceLink(BUNDLED_CATALOG, 'base:innate:ref-1062')).toBeUndefined()
    expect(nativeReferenceDisposition(BUNDLED_CATALOG, 'base:innate:ref-1062')).toBe('native-identity-review')
  })

  it('does not apply reviewed links to another catalog revision or a forged checksum', () => {
    const id = 'base:passive:ref-939'
    const variants = [
      { ...BUNDLED_CATALOG, id: 'foreign-catalog' },
      { ...BUNDLED_CATALOG, revisionId: 'foreign-revision' },
      { ...BUNDLED_CATALOG, checksum: 'forged' },
      { ...BUNDLED_CATALOG, legacy: { sourceContentDigest: 'forged' } },
    ] as CatalogSnapshot[]
    for (const catalog of variants) {
      expect(nativeReferenceLink(catalog, id)).toBeUndefined()
      expect(nativeReferenceAlternatives(catalog, 'base:passive:58')).toEqual([])
      expect(nativeReferenceDisposition(catalog, id)).toBeUndefined()
      expect(() => validateNativeReferenceLinks(NATIVE_REFERENCE_LINKS, catalog)).toThrow('catalog pin differs')
    }
  })

  it('rejects altered source, target, and class-membership evidence even under the correct checksum', () => {
    const id = 'base:passive:ref-939'
    const target = BUNDLED_CATALOG.entities['base:passive:58']!
    const job = BUNDLED_CATALOG.entities['base:job:13']!
    const variants = [
      changedEntity(id, { rawDescription: 'An unsupported replacement claim' }),
      changedEntity(target.id, { fields: { ...target.fields, 'Native source record': { state: 'known', value: { ...nativeSourceRecord(target), PP: 999 } as JsonValue } } }),
      changedEntity(job.id, { fields: { ...job.fields, 'Native source record': { state: 'known', value: { ...nativeSourceRecord(job), PassiveIDs: [] } as JsonValue } } }),
    ]
    for (const catalog of variants) {
      expect(nativeReferenceLink(catalog, id)).toBeUndefined()
      expect(nativeReferenceAlternatives(catalog, 'base:passive:58')).toEqual([])
      expect(() => validateNativeReferenceLinks(NATIVE_REFERENCE_LINKS, catalog)).toThrow(/baseline|record evidence/)
    }
  })

  it('validates native fingerprints and actual snapshot contents', () => {
    const manifest = { ...NATIVE_REFERENCE_LINKS, native: { ...NATIVE_REFERENCE_LINKS.native, executableSha256: '0'.repeat(64) } }
    expect(() => validateNativeReferenceLinks(manifest)).toThrow('source fingerprints differ')
    const snapshot = { ...NATIVE_GAME_DATA, databases: { ...NATIVE_GAME_DATA.databases, passive: [] } } as NativeGameSnapshot
    expect(() => validateNativeReferenceLinks(NATIVE_REFERENCE_LINKS, BUNDLED_CATALOG, snapshot)).toThrow('source fingerprints differ')
  })

  it('requires each review to keep its substantive source and native relationship evidence', () => {
    for (const review of new Set(NATIVE_REFERENCE_LINKS.links.map(link => link.review))) {
      const link = NATIVE_REFERENCE_LINKS.links.find(entry => entry.review === review)!
      const withoutProof = { ...link, evidence: { ...link.evidence, sourceFields: {}, nativeFields: { ID: link.evidence.nativeFields.ID! }, relatedRecords: [] } }
      const manifest = { ...NATIVE_REFERENCE_LINKS, links: NATIVE_REFERENCE_LINKS.links.map(entry => entry === link ? withoutProof : entry) }
      expect(() => validateNativeReferenceLinks(manifest)).toThrow('proof is insufficient')
      if (link.evidence.relatedRecords.length) {
        const withoutRelationships = { ...link, evidence: { ...link.evidence, relatedRecords: [] } }
        expect(() => validateNativeReferenceLinks({ ...NATIVE_REFERENCE_LINKS, links: NATIVE_REFERENCE_LINKS.links.map(entry => entry === link ? withoutRelationships : entry) })).toThrow('proof is insufficient')
      }
    }
  })

  it('requires all raw monster stats, action names, and a complete loot availability roster', () => {
    const link = NATIVE_REFERENCE_LINKS.links.find(entry => entry.review === 'monster-facts')!
    for (const field of ['HP', 'Abilities']) {
      const sourceFields = { ...link.evidence.sourceFields }
      delete sourceFields[field]
      const changed = { ...link, evidence: { ...link.evidence, sourceFields } }
      expect(() => validateNativeReferenceLinks({ ...NATIVE_REFERENCE_LINKS, links: NATIVE_REFERENCE_LINKS.links.map(entry => entry === link ? changed : entry) })).toThrow('proof is insufficient')
    }
    const sourceFields = { ...link.evidence.sourceFields }
    delete sourceFields.Drops
    delete sourceFields.Steals
    const changed = { ...link, evidence: { ...link.evidence, sourceFields } }
    expect(() => validateNativeReferenceLinks({ ...NATIVE_REFERENCE_LINKS, links: NATIVE_REFERENCE_LINKS.links.map(entry => entry === link ? changed : entry) })).toThrow('proof is insufficient')
  })

  it('rejects identity collisions, changed proof values, and incomplete dispositions', () => {
    const first = NATIVE_REFERENCE_LINKS.links[0]!
    const duplicate = { ...NATIVE_REFERENCE_LINKS, links: [...NATIVE_REFERENCE_LINKS.links, first] }
    expect(() => validateNativeReferenceLinks(duplicate)).toThrow('identity collision')
    const altered = { ...first, evidence: { ...first.evidence, nativeFields: { ...first.evidence.nativeFields, ID: -1 } } }
    expect(() => validateNativeReferenceLinks({ ...NATIVE_REFERENCE_LINKS, links: [altered, ...NATIVE_REFERENCE_LINKS.links.slice(1)] })).toThrow('record evidence differs')
    expect(() => validateNativeReferenceLinks({ ...NATIVE_REFERENCE_LINKS, dispositions: NATIVE_REFERENCE_LINKS.dispositions.slice(1) })).toThrow('Missing native reference disposition')
    const command = nativeReferenceLink(BUNDLED_CATALOG, 'base:command:ref-28')!
    const relationChanged = { ...command, relation: 'same-definition' as const }
    const invalidRelation = { ...NATIVE_REFERENCE_LINKS, links: NATIVE_REFERENCE_LINKS.links.map(link => link.sourceId === command.sourceId ? relationChanged : link) } satisfies NativeReferenceLinksManifest
    expect(() => validateNativeReferenceLinks(invalidRelation)).toThrow('Invalid native reference relation')
  })
})
