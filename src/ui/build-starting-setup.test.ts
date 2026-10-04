import { describe, expect, it } from 'vitest'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { createSampleLocalData } from '../domain/sample-data'
import { createPlaythroughWithSetup } from '../domain/game-setups'
import { buildStartingSetup } from './build-starting-setup'

describe('new Build starting rules', () => {
  it('uses fresh planning settings instead of copying a sample checkpoint', () => {
    const sample = createSampleLocalData(DEFAULT_CATALOG)
    const fresh = createPlaythroughWithSetup(sample, { label: 'Fresh adventure', catalogLock: {} })
    expect(buildStartingSetup(fresh).id).toBe(fresh.planningGameSetupRevisionId)
    expect(buildStartingSetup(fresh).id).not.toBe(sample.planningGameSetupRevisionId)
    expect(fresh.buildRevisions).toEqual(sample.buildRevisions)
  })

  it('reuses a personal Build setup while giving an explicit Team or route setup precedence', () => {
    const data = createSampleLocalData(DEFAULT_CATALOG)
    const build = Object.values(data.builds)[0]!
    const personal = { ...data, builds: { ...data.builds, [build.id]: { ...build, title: 'My build', tags: [] } } }
    const fresh = createPlaythroughWithSetup(personal, { label: 'Fresh adventure', catalogLock: {} })
    expect(buildStartingSetup(fresh)).toMatchObject({ id: data.buildRevisions[build.latestRevisionId!]!.gameSetupRevisionId, description: expect.stringContaining('My build') })
    expect(buildStartingSetup(fresh, fresh.planningGameSetupRevisionId).id).toBe(fresh.planningGameSetupRevisionId)
    expect(buildStartingSetup(fresh, 'unavailable-request').id).toBe('unavailable-request')
  })
})
