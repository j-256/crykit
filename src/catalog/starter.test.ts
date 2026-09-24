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
import { STARTER_CATALOG, STARTER_CATALOG_COUNTS, STARTER_CATALOG_GAPS } from './starter'

const EXPECTED_COUNTS = {
  item: 959,
  class: 28,
  ability: 253,
  passive: 58,
  innate: 28,
  monsterMagic: 20,
  monster: 269,
  command: 24,
  status: 115,
  recipe: 2,
  location: 113,
  other: 26,
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
  it('contains the revision-pinned community reference coverage', () => {
    expect(STARTER_CATALOG_COUNTS).toEqual(EXPECTED_COUNTS)
    expect(Object.keys(STARTER_CATALOG.entities)).toHaveLength(1_895)
    expect(STARTER_CATALOG.applicability.state).toBe('unknown')
    expect(STARTER_CATALOG.rights.state).toBe('unknown')
  })

  it('keeps identities unique and all normalized values explicit', () => {
    const recordsById = new Map(STARTER_NAME_RECORDS.map((record) => [record[0], record]))
    expect(recordsById.size).toBe(STARTER_NAME_RECORDS.length)

    for (const [key, entity] of Object.entries(STARTER_CATALOG.entities)) {
      expect(entity.id).toBe(key)
      expect(entity.name.trim()).toBe(entity.name)
      expect(entity.name).not.toBe('')
      expect(new Set(entity.aliases).size).toBe(entity.aliases.length)
      for (const value of Object.values(entity.fields)) expect(['known', 'unknown', 'conflicting', 'notApplicable']).toContain(value.state)
      expect(entity.slotKinds).toBeDefined()
      expect(entity.occupiesSlots).toBeDefined()
      expect(entity.ppCost).toBeDefined()
      expect(entity.requirements).toBeDefined()
      expect(entity.grants).toBeDefined()
    }
  })

  it('preserves representative class, skill, item, monster, and status details', () => {
    const entities = Object.values(STARTER_CATALOG.entities)
    const find = (kind: string, name: string) => entities.find((entity) => entity.kind === kind && entity.name === name)!
    const cleric = find('class', 'Cleric')
    const starFlare = find('ability', 'Star Flare')
    const innerWarmth = find('passive', 'Inner Warmth')
    const broadsword = find('item', 'Broadsword')
    const akamanto = find('monster', 'Akamanto')
    const burn = find('status', 'Burn')
    const dogeShield = find('item', 'Doge Shield')
    const deityEye = find('item', 'Deity Eye')
    const safeguard = find('passive', 'Safeguard')
    const attackStyle = find('status', 'Attack Style')

    expect(cleric.fields['Stat growth']).toMatchObject({ state: 'known', value: { Spirit: 5, Agility: 1.5 } })
    expect(cleric.fields['Total LP to master']).toMatchObject({ state: 'known', value: 30 })
    expect(starFlare.fields['MP cost']).toMatchObject({ state: 'known', value: 56 })
    expect(starFlare.fields['Vanilla mode notes']).toMatchObject({ state: 'known', value: expect.arrayContaining([expect.stringContaining('60 MP 52 CT')]) })
    expect(innerWarmth.ppCost).toMatchObject({ state: 'known', value: 1 })
    expect(broadsword.fields.Attack).toMatchObject({ state: 'known', value: 79 })
    expect(broadsword.occupiesSlots).toMatchObject({ state: 'known', value: 2 })
    expect(akamanto.fields.HP).toMatchObject({ state: 'known', value: 27_000 })
    expect(akamanto.fields.Abilities).toMatchObject({ state: 'known', value: expect.arrayContaining(['Death Sentence']) })
    expect(burn.fields.Effect).toMatchObject({ state: 'known', value: 'Damage per turn: 15%' })
    expect(dogeShield.fields.Description).toMatchObject({ state: 'known', value: expect.stringContaining('counter') })
    expect(dogeShield.fields.Location).toMatchObject({ state: 'unknown' })
    expect(deityEye.fields.Description).toMatchObject({ state: 'known', value: expect.stringContaining('Dropped by') })
    expect(safeguard.sources.some((source) => source.sourceId.includes('/Safeguard?oldid='))).toBe(true)
    expect(attackStyle.fields.Effect).toMatchObject({ state: 'known', value: expect.stringContaining('Take 35% more physical damage') })
    expect(entities.some((entity) => ['Areas', 'TemplateTest', 'MonsterBox2 clone for testing'].includes(entity.name))).toBe(false)
  })

  it('retains every known coverage gap without inferring missing details', () => {
    expect(STARTER_CATALOG_GAPS.namesWithoutWikiDetails).toContainEqual(expect.objectContaining({ kind: 'class', name: 'Bloodmage' }))
    expect(STARTER_CATALOG_GAPS.wikiRedlinks.length).toBeGreaterThan(0)
    expect(STARTER_CATALOG_GAPS.pagesWithoutStandaloneDefinitions.length).toBeGreaterThan(0)
    expect(STARTER_CATALOG_GAPS.extractionIssues).toEqual([])

    const bloodmage = Object.values(STARTER_CATALOG.entities).find((entity) => entity.kind === 'class' && entity.name === 'Bloodmage')!
    expect(bloodmage.fields['Wiki coverage']).toMatchObject({ state: 'unknown', reason: expect.stringContaining('No matching detail') })
    expect(bloodmage.sources.some((source) => source.sourceId.includes('nintendo.com'))).toBe(true)
  })

  it('excludes Archipelago progression wrappers and traps', () => {
    const names = new Set(Object.values(STARTER_CATALOG.entities).map((entity) => entity.name))
    for (const label of RANDOMIZER_ONLY_LABELS) expect(names.has(label)).toBe(false)
    expect([...names].filter((name) => name.startsWith('Progressive '))).toEqual([])
  })

  it('uses public source URLs and revision locators without archive identities', () => {
    const allowed = new Set<string>(Object.values(STARTER_SOURCE_URLS))
    expect(allowed.size).toBeGreaterThan(4)

    for (const entity of Object.values(STARTER_CATALOG.entities)) {
      expect(entity.sources.length).toBeGreaterThan(0)
      for (const source of entity.sources) {
        expect(source.sourceId).toMatch(/^https:\/\//)
        expect(source.sourceId).not.toMatch(/^(?:source:)?sha256:/)
        expect(allowed.has(source.sourceId) || source.sourceId.startsWith('https://crystal-project.fandom.com/')).toBe(true)
        expect(source.checkedAt).toBeUndefined()
        if (!allowed.has(source.sourceId) && source.sourceId.startsWith('https://crystal-project.fandom.com/wiki/') && !source.sourceId.endsWith('/Special:Statistics')) {
          expect(source.snapshot).toMatch(/^revision \d+$/)
        }
      }
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
    expect(starterEntitySourceLabel(broadsword!)).toContain('Base game names')
    expect(starterEntitySourceLabel(broadsword!)).toContain('Community wiki · Broadsword')
    expect(starterEntitySourceLabel(broadestsword!)).toBe('Equipment Expansion')

    const adrenalines = Object.values(STARTER_CATALOG.entities)
      .filter((entity) => entity.name === 'Adrenaline')
    expect(adrenalines).toHaveLength(2)
    expect(adrenalines.map(starterEntitySourceLabel).some((label) => label?.includes('Community wiki · Warrior'))).toBe(true)
    expect(adrenalines.map(starterEntitySourceLabel).some((label) => label?.includes('Base Monster Magic names'))).toBe(true)
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
