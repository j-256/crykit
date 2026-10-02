import { describe, expect, it } from 'vitest'
import { normalizeBuildTags } from './build-tags'
import { createBuild, saveBuildRevision, updateBuild } from './builds'
import { asId } from './core'
import { MAX_COLLECTION_LENGTH, MAX_SHORT_TEXT_LENGTH } from './limits'
import { createTestLocalData, TEST_GAME_SETUP_ID, TEST_GAME_SETUP_REVISION_ID } from './test-helpers'
import type { BuildId, BuildRevisionId } from './types'

describe('authored Build tags', () => {
  it('trims and deduplicates labels while retaining spelling, order, and punctuation', () => {
    const input = [' Healer ', '', '  ', 'HEALER', 'early game', 'Early Game', 'fire, ice', '日本語']
    expect(normalizeBuildTags(input)).toEqual(['Healer', 'early game', 'fire, ice', '日本語'])
    expect(input[0]).toBe(' Healer ')
  })

  it('rejects values outside the persisted bounds', () => {
    expect(() => normalizeBuildTags(['x'.repeat(MAX_SHORT_TEXT_LENGTH + 1)])).toThrow(/Build tag must be at most/)
    expect(() => normalizeBuildTags(Array.from({ length: MAX_COLLECTION_LENGTH + 1 }, () => 'label'))).toThrow(/Build tags must contain at most/)
  })

  it('updates metadata independently of checkpoints and preserves stored labels during unrelated edits', () => {
    const id = asId<BuildId>('synthetic-tagged-build')
    let data = createBuild(createTestLocalData(), { id, title: 'Synthetic Build', kind: 'build', gameSetupId: TEST_GAME_SETUP_ID, tags: [' support ', 'SUPPORT', ''] })
    expect(data.builds[id]!.tags).toEqual(['support'])
    data = saveBuildRevision(data, { buildId: id, id: asId<BuildRevisionId>('synthetic-checkpoint'), gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID, content: { primaryClass: null, secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [] } })
    const before = data
    const tagged = updateBuild(data, { buildId: id, tags: ['tank', ' Tank ', 'early game'], expectedRevision: data.revision })
    expect(tagged.builds[id]!.tags).toEqual(['tank', 'early game'])
    expect(tagged.builds[id]!.latestRevisionId).toBe(before.builds[id]!.latestRevisionId)
    expect(tagged.buildRevisions).toBe(before.buildRevisions)
    expect(tagged.playthroughs).toBe(before.playthroughs)
    expect(before.builds[id]!.tags).toEqual(['support'])
    expect(updateBuild(tagged, { buildId: id, tags: [] }).builds[id]!.tags).toEqual([])
    expect(() => updateBuild(tagged, { buildId: id, tags: ['x'.repeat(MAX_SHORT_TEXT_LENGTH + 1)] })).toThrow()
    expect(tagged.builds[id]!.tags).toEqual(['tank', 'early game'])

    const legacy = { ...tagged, builds: { ...tagged.builds, [id]: { ...tagged.builds[id]!, tags: [' Support ', 'support', ''] } } }
    const renamed = updateBuild(legacy, { buildId: id, title: 'Renamed Build' })
    expect(renamed.builds[id]!.tags).toBe(legacy.builds[id]!.tags)
    expect(() => updateBuild(tagged, { buildId: id, tags: ['stale'], expectedRevision: before.revision })).toThrowError(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
  })
})
