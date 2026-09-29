import { describe, expect, it } from 'vitest'

import { DEFAULT_CATALOG } from './bundled'
import { VANILLA_CLASS_SEAL_PAIRS } from './class-seals'
import { STARTER_NAME_RECORDS } from './data'

describe('vanilla class seal tracker roster', () => {
  it('maps each declared vanilla class to an explicit class and seal definition', () => {
    const classIds = new Set<string>()
    const sealIds = new Set<string>()

    for (const pair of VANILLA_CLASS_SEAL_PAIRS) {
      const classEntity = DEFAULT_CATALOG.entities[pair.classEntityId]
      const sealEntity = DEFAULT_CATALOG.entities[pair.sealEntityId]
      expect(classEntity?.kind, pair.classEntityId).toBe('class')
      expect(sealEntity?.kind, pair.sealEntityId).toBe('item')
      expect(sealEntity?.name, pair.sealEntityId).toBe(`${classEntity?.name} Seal`)
      classIds.add(pair.classEntityId)
      sealIds.add(pair.sealEntityId)
    }

    expect(classIds.size).toBe(VANILLA_CLASS_SEAL_PAIRS.length)
    expect(sealIds.size).toBe(VANILLA_CLASS_SEAL_PAIRS.length)
    expect([...classIds].sort()).toEqual(STARTER_NAME_RECORDS.filter(([id, kind]) => kind === 'class' && id.startsWith('base:class:')).map(([id]) => id).sort())
  })
})
