import { describe, expect, it } from 'vitest'
import { DEFAULT_CATALOG } from './bundled'
import { QUINTAR_BREEDING_STEPS, QUINTAR_BREEDING_STEP_IDS, QUINTAR_NURSERY_CAPACITY, QUINTAR_STARTING_QUINTARS, QUINTAR_STEP, quintarParentsAfterStep, quintarRaceRequirements } from './quintar-breeding'
import { QUINTAR_GUIDE_SUPPLEMENT } from './quintar-guide-supplement'
import { QUINTAR_STEP_REFERENCES, quintarOcarinaPrice } from './quintar-references'
import { QUINTAR_PARTNER_RACE_WINS, quintarOffspring } from './quintar-native-rules'
import worldMap from './world-map.json'

describe('Golden Quintar guided route', () => {
  it('links steps only to exact native numeric records', () => {
    for (const step of QUINTAR_BREEDING_STEPS) {
      const targets = QUINTAR_STEP_REFERENCES[step.id]!
      expect(targets.length).toBeGreaterThan(0)
      expect(new Set(targets.map(target => target.entityId)).size).toBe(targets.length)
      for (const target of targets) {
        expect(target.entityId).toMatch(/^base:(item|monster):\d+$/)
        expect(DEFAULT_CATALOG.entities[target.entityId]).toMatchObject({ kind: target.kind, name: target.name })
      }
    }
    expect(QUINTAR_STARTING_QUINTARS.map(quintar => quintar.monsterID)).toEqual([317, 304, 318, 316])
  })

  it('keeps readable landmark tips attributed separately from exact native placements', () => {
    expect(QUINTAR_GUIDE_SUPPLEMENT.source).toMatchObject({ revision: '13333', sourceId: 'https://crystal-project.fandom.com/wiki/Quintar_Breeding?oldid=13333' })
    const find = (id: string) => QUINTAR_BREEDING_STEPS.find(step => step.id === id)!
    expect(find(QUINTAR_STEP.babel).instruction).toMatch(/swimming mount.*Quintar Mausoleum.*Quintar Reserve.*switch/)
    expect(find(QUINTAR_STEP.ocarina).instruction).toContain('Dione Shrine')
    expect(find(QUINTAR_STEP.trustyBlue).instruction).toMatch(/east of Yamagawa M.A.*northwest of Dione Shrine/)
    expect(find(QUINTAR_STEP.trustyRed).instruction).toMatch(/Overpass northwest of Okimoto N.S.*north of Sara Sara Beach/)
    expect(find(QUINTAR_STEP.wokeRiver).instruction).toMatch(/northwest of the River Cat's Ego.*northwest of Triton Shrine/)
    expect(find(QUINTAR_STEP.brutishDesert).instruction).toMatch(/nests northeast or northwest of Sara Sara Bazaar/)
    for (const placement of Object.values(QUINTAR_GUIDE_SUPPLEMENT.placements)) for (const entityID of placement.entityIDs) {
      const marker = worldMap.markers.find(entry => entry.entityId === entityID)!
      expect(marker).toBeDefined()
      const expected = 'monsterID' in placement ? { family: 'monster', id: placement.monsterID } : { family: 'item', id: placement.itemID }
      expect(marker.targets).toEqual(expect.arrayContaining([expect.objectContaining(expected)]))
      if (entityID === 2153) expect(marker.region).toBe('Quintar Mausoleum')
      if (entityID === 2227) expect(marker.region).toBe('Dione Shrine')
    }
  })

  it('uses native pairings and stays within nursery capacity while retaining future parents', () => {
    const roster = new Set<string>()
    const completed = new Set<string>()
    for (const step of QUINTAR_BREEDING_STEPS) {
      expect(completed.has(step.id)).toBe(false)
      for (const prerequisite of step.requires) expect(completed.has(prerequisite)).toBe(true)
      if (step.parents) {
        expect(quintarOffspring(...step.parents)).toEqual({ type: step.result!.type, nature: step.result!.nature })
        for (const parent of step.parents) expect(roster.has(parent.name)).toBe(true)
      }
      if (step.result) {
        expect(roster.size).toBeLessThan(QUINTAR_NURSERY_CAPACITY)
        roster.add(step.result.name)
      }
      const advice = quintarParentsAfterStep(step)
      for (const name of advice.keep) expect(roster.has(name)).toBe(true)
      for (const name of advice.release) roster.delete(name)
      completed.add(step.id)
    }
    expect([...roster]).toEqual(['Brutish Gold'])
  })

  it('preserves established step meanings and both earlier generated-recipe identity orders', () => {
    for (const id of Object.values(QUINTAR_STEP)) expect(QUINTAR_BREEDING_STEP_IDS.has(id)).toBe(true)
    const golden = QUINTAR_BREEDING_STEPS.find(step => step.id === QUINTAR_STEP.golden)!
    expect(golden.parents?.map(parent => parent.name)).toEqual(['Fancy Black', 'Woke Aqua'])
    expect(QUINTAR_BREEDING_STEP_IDS.has('native-pairing-v1:brutish-gold:fancy-aqua+woke-black')).toBe(true)
    expect(QUINTAR_BREEDING_STEP_IDS.has('native-pairing-v1:brutish-gold:woke-black+fancy-aqua')).toBe(true)
    expect(QUINTAR_BREEDING_STEP_IDS.has('native-pairing-v1:woke-blue:fancy-black+trusty-blue')).toBe(true)
    expect(QUINTAR_BREEDING_STEP_IDS.has('native-pairing-v1:golden:fancy-black+trusty-blue')).toBe(false)
    expect(QUINTAR_BREEDING_STEP_IDS.has('native-pairing-v1:unknown')).toBe(false)
  })

  it('derives the Ocarina price from matching native item and shop records', () => {
    expect(quintarOcarinaPrice(DEFAULT_CATALOG)).toBe(120000)
    expect(quintarOcarinaPrice(undefined)).toBeUndefined()
    expect(quintarOcarinaPrice({ ...DEFAULT_CATALOG, legacy: {} })).toBeUndefined()
  })

  it('assigns native cumulative race thresholds by partner type', () => {
    const find = (id: string) => QUINTAR_BREEDING_STEPS.find(step => step.id === id)!
    expect(quintarRaceRequirements(find(QUINTAR_STEP.fancyRed))).toEqual([{ name: 'Trusty Red', wins: 2 }, { name: 'Woke River', wins: 0 }])
    expect(quintarRaceRequirements(find(QUINTAR_STEP.wokeAqua))).toEqual([{ name: 'Brutish Aqua', wins: 2 }, { name: 'Woke River', wins: 4 }])
    expect(quintarRaceRequirements(find(QUINTAR_STEP.fancyHighland))).toEqual([{ name: 'Brutish Highland', wins: 0 }, { name: 'Fancy Red', wins: 1 }])
    expect(quintarRaceRequirements(find(QUINTAR_STEP.fancyDesert))).toEqual([{ name: 'Brutish Desert', wins: 0 }, { name: 'Fancy Red', wins: 1 }])
    expect(QUINTAR_PARTNER_RACE_WINS).toEqual({ Blue: 0, Red: 0, Desert: 1, Highland: 1, River: 2, Black: 3, Aqua: 4, Gold: 5 })
    expect(quintarParentsAfterStep(find(QUINTAR_STEP.wokeAqua)).keep).toContain('Woke River')
    expect(quintarParentsAfterStep(find(QUINTAR_STEP.fancyDesert)).keep).toContain('Fancy Red')
  })
})
