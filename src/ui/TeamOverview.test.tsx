import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { asId } from '../domain'
import { addTestBuild, createTestLocalData, known, TEST_GAME_SETUP_REVISION_ID } from '../domain/test-helpers'
import type { BuildRevisionId, GameSetupRevisionId } from '../domain/types'
import { TeamOverview, teamSetupStatus } from './TeamOverview'

describe('Team overview', () => {
  it('compares selected Game Setup behavior without treating a renamed copy as different rules', () => {
    const data = addTestBuild(createTestLocalData(), 'member', '', {})
    const original = data.buildRevisions['member-revision']!
    const setup = data.gameSetups[TEST_GAME_SETUP_REVISION_ID]!
    const compatibleId = asId<GameSetupRevisionId>('compatible-setup')
    const differentId = asId<GameSetupRevisionId>('different-setup')
    const compatibleRevisionId = asId<BuildRevisionId>('compatible-revision')
    const differentRevisionId = asId<BuildRevisionId>('different-revision')
    const next = {
      ...data,
      gameSetups: {
        ...data.gameSetups,
        [compatibleId]: { ...setup, id: compatibleId, label: 'Renamed setup' },
        [differentId]: { ...setup, id: differentId, ppLimit: known(11) },
      },
      buildRevisions: {
        ...data.buildRevisions,
        [compatibleRevisionId]: { ...original, id: compatibleRevisionId, gameSetupRevisionId: compatibleId },
        [differentRevisionId]: { ...original, id: differentRevisionId, gameSetupRevisionId: differentId },
      },
    }
    expect(teamSetupStatus([null, null, null, null], next)).toBe('none')
    expect(teamSetupStatus([original.id, null, null, null], next)).toBe('one')
    expect(teamSetupStatus([original.id, compatibleRevisionId, null, null], next)).toBe('compatible')
    expect(teamSetupStatus([original.id, differentRevisionId, null, null], next)).toBe('different')
    expect(teamSetupStatus([original.id, asId<BuildRevisionId>('missing-revision'), null, null], next)).toBe('missing')
  })

  it('shows full loadouts on the detail page and a useful equipment preview on the Teams list', () => {
    const data = addTestBuild(createTestLocalData(), 'member', '', {})
    const id = asId<BuildRevisionId>('member-revision')
    const markup = renderToStaticMarkup(<TeamOverview catalogs={[]} localData={data} slots={[id, null, null, null]}/>)
    expect(markup).toContain('1/4 members')
    expect(markup).toContain('Team layout')
    expect(markup).toContain('4 across')
    expect(markup).toContain('2 by 2')
    expect(markup).toContain('1 at a time')
    expect(markup).toContain('Equipment')
    expect(markup).toContain('Passives')
    expect(markup).not.toContain('Inspect loadout')
    expect(markup).not.toContain('build-card__classes')
    expect(markup.match(/Team slot \d overview/g)).toHaveLength(4)
    expect(markup).toContain('Unassigned member')
    const listMarkup = renderToStaticMarkup(<TeamOverview catalogs={[]} compact localData={data} slots={[id, null, null, null]}/>)
    expect(listMarkup).toContain('Main hand')
    expect(listMarkup).not.toContain('Team layout')
  })
})
