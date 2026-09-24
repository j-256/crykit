import { describe, expect, it } from 'vitest'
import { NativeCatalogSnapshotSchema } from '../interchange/native-schema'
import { sha256 } from '../interchange/util'
import {
  STARTER_CATALOG_CONTENT_DIGEST,
  STARTER_NAME_RECORDS,
  STARTER_SOURCE_URLS,
  starterCatalogChecksumInput,
} from './data'
import { starterEntitySourceLabel, starterSourceLabel } from './provenance'
import { STARTER_CATALOG, STARTER_CATALOG_COUNTS } from './starter'

const EXPECTED_COUNTS = {
  item: 792,
  class: 28,
  ability: 169,
  passive: 51,
  innate: 28,
  monsterMagic: 20,
} as const

const RANDOMIZER_ONLY_LABELS = [
  'Progressive 1H Sword',
  'Progressive Light Body',
  'Dialog Trap',
  'Progressive Level',
  'Home Point Unlock',
  'Victory',
] as const

describe('built-in starter catalog', () => {
  it('contains the reviewed partial public name coverage', () => {
    expect(STARTER_CATALOG_COUNTS).toEqual(EXPECTED_COUNTS)
    expect(Object.keys(STARTER_CATALOG.entities)).toHaveLength(1_088)
    expect(STARTER_CATALOG.applicability.state).toBe('unknown')
    expect(STARTER_CATALOG.rights.state).toBe('unknown')
  })

  it('keeps identities unique and every mechanic explicitly unknown', () => {
    const recordsById = new Map(STARTER_NAME_RECORDS.map((record) => [record[0], record]))
    expect(recordsById.size).toBe(STARTER_NAME_RECORDS.length)

    for (const [key, entity] of Object.entries(STARTER_CATALOG.entities)) {
      expect(entity.id).toBe(key)
      expect(entity.name.trim()).toBe(entity.name)
      expect(entity.name).not.toBe('')
      expect(entity.aliases).toEqual([])
      expect(entity.fields).toEqual({})
      expect(entity.rawDescription).toBeUndefined()
      expect(entity.slotKinds?.state).toBe('unknown')
      expect(entity.occupiesSlots?.state).toBe('unknown')
      expect(entity.ppCost?.state).toBe('unknown')
      expect(entity.requirements?.state).toBe('unknown')
      expect(entity.grants?.state).toBe('unknown')
      expect(entity.listedContributions).toBeUndefined()
    }
  })

  it('excludes Archipelago progression wrappers and traps', () => {
    const names = new Set(Object.values(STARTER_CATALOG.entities).map((entity) => entity.name))
    for (const label of RANDOMIZER_ONLY_LABELS) expect(names.has(label)).toBe(false)
    expect([...names].filter((name) => name.startsWith('Progressive '))).toEqual([])
  })

  it('uses only the reviewed public source allowlist without archive identities', () => {
    const allowed = new Set(Object.values(STARTER_SOURCE_URLS))
    expect(allowed.size).toBeGreaterThan(4)

    for (const entity of Object.values(STARTER_CATALOG.entities)) {
      expect(entity.sources).toHaveLength(1)
      expect(allowed).toContain(entity.sources[0]?.sourceId)
      expect(entity.sources[0]?.sourceId).toMatch(/^https:\/\//)
      expect(entity.sources[0]?.sourceId).not.toMatch(/^(?:source:)?sha256:/)
      expect(entity.sources[0]?.checkedAt).toBeUndefined()
    }
    expect(STARTER_CATALOG.checksum).toMatch(/^builtin:sha256:[0-9a-f]{64}$/)
  })

  it('provides short provenance labels that distinguish duplicate names', () => {
    for (const sourceId of Object.values(STARTER_SOURCE_URLS)) {
      expect(starterSourceLabel(sourceId)).toBeTruthy()
    }
    expect(starterSourceLabel('https://example.invalid/not-a-starter-source')).toBeUndefined()

    const broadsword = Object.values(STARTER_CATALOG.entities)
      .find((entity) => entity.name === 'Broadsword')
    const broadestsword = Object.values(STARTER_CATALOG.entities)
      .find((entity) => entity.name === 'Broadestsword')
    expect(starterEntitySourceLabel(broadsword!)).toBe('Base game names')
    expect(starterEntitySourceLabel(broadestsword!)).toBe('Equipment Expansion')

    const adrenalines = Object.values(STARTER_CATALOG.entities)
      .filter((entity) => entity.name === 'Adrenaline')
    expect(adrenalines).toHaveLength(2)
    expect(new Set(adrenalines.map(starterEntitySourceLabel))).toEqual(new Set([
      'Community wiki · Warrior',
      'Base Monster Magic names',
    ]))
  })

  it('matches its static content digest and native catalog schema', async () => {
    const digest = await sha256(new TextEncoder().encode(starterCatalogChecksumInput()))
    expect(digest).toBe(STARTER_CATALOG_CONTENT_DIGEST)
    expect(STARTER_CATALOG.checksum).toBe(`builtin:sha256:${digest}`)
    expect(NativeCatalogSnapshotSchema.safeParse(STARTER_CATALOG).success).toBe(true)
  })

  it('is recursively immutable at runtime', () => {
    expect(Object.isFrozen(STARTER_CATALOG)).toBe(true)
    expect(Object.isFrozen(STARTER_CATALOG.entities)).toBe(true)
    expect(Object.isFrozen(Object.values(STARTER_CATALOG.entities)[0])).toBe(true)
    expect(Object.isFrozen(Object.values(STARTER_CATALOG.entities)[0]?.sources)).toBe(true)
  })
})
