import { describe, expect, it } from 'vitest'
import { DEFAULT_CATALOG } from './bundled'
import { QUINTAR_BREEDING_STEPS, QUINTAR_NURSERY_CAPACITY, QUINTAR_STEP, quintarParentsAfterStep, quintarRaceRequirements } from './quintar-breeding'
import { QUINTAR_STEP_REFERENCES } from './quintar-references'
import wikiData from './wiki-data.json'

describe('Golden Quintar guided route', () => {
  it('links each step only to exact identities in the bundled reference', () => {
    const catalog = DEFAULT_CATALOG
    for (const step of QUINTAR_BREEDING_STEPS) {
      const targets = QUINTAR_STEP_REFERENCES[step.id]
      expect(targets.length).toBeGreaterThan(0)
      expect(new Set(targets.map(target => target.entityId)).size).toBe(targets.length)
      for (const target of targets) expect(catalog.entities[target.entityId]).toMatchObject({ kind: target.kind, name: target.name })
      if (step.parents) expect(Object.values(catalog.entities).some(entity => entity.name === step.result?.name)).toBe(false)
    }
  })

  it('uses documented pairings and can finish within nursery capacity while retaining future parents', () => {
    const documented = wikiData.entities.find(entity => entity.name === 'Quintar Breeding')!
    const method = (documented.fields as Record<string, { value?: unknown }>)['Section: Method 2']!.value as string
    const roster = new Set<string>()
    const completed = new Set<string>()
    const uniqueIds = new Set<string>()
    for (const step of QUINTAR_BREEDING_STEPS) {
      expect(uniqueIds.has(step.id)).toBe(false)
      uniqueIds.add(step.id)
      for (const prerequisite of step.requires) expect(completed.has(prerequisite)).toBe(true)
      if (step.parents) {
        const [first, second] = step.parents
        expect(method).toContain(`${first.name}${step.id === QUINTAR_STEP.golden ? ' + ' : ' with '}${second.name} to get ${step.result!.name}`)
        for (const parent of step.parents) expect(roster.has(parent.name)).toBe(true)
        expect(roster.size).toBeLessThan(QUINTAR_NURSERY_CAPACITY)
      }
      if (step.result) roster.add(step.result.name)
      const advice = quintarParentsAfterStep(step)
      for (const name of advice.keep) expect(roster.has(name)).toBe(true)
      for (const name of advice.release) roster.delete(name)
      completed.add(step.id)
    }
    expect([...roster]).toEqual(['Brutish Gold'])
  })

  it('assigns cumulative race thresholds to the parent facing the partner type', () => {
    const find = (id: string) => QUINTAR_BREEDING_STEPS.find(step => step.id === id)!
    expect(quintarRaceRequirements(find(QUINTAR_STEP.fancyRed))).toEqual([{ name: 'Trusty Red', wins: 2 }, { name: 'Woke River', wins: 0 }])
    expect(quintarRaceRequirements(find(QUINTAR_STEP.wokeAqua))).toEqual([{ name: 'Brutish Aqua', wins: 2 }, { name: 'Woke River', wins: 4 }])
    expect(quintarRaceRequirements(find(QUINTAR_STEP.fancyBlack))).toEqual([{ name: 'Brutish Black', wins: 0 }, { name: 'Fancy Red', wins: 3 }])
    expect(quintarRaceRequirements(find(QUINTAR_STEP.golden))).toEqual([{ name: 'Fancy Black', wins: 4 }, { name: 'Woke Aqua', wins: 3 }])
    expect(quintarParentsAfterStep(find(QUINTAR_STEP.wokeAqua)).keep).toContain('Woke River')
    expect(quintarParentsAfterStep(find(QUINTAR_STEP.fancyDesert)).keep).toContain('Fancy Red')
  })
})
