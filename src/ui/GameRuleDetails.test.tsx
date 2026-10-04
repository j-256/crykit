import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { defaultCalculation } from '../domain/calculation-plan'
import { resolveGameRules } from '../domain/game-rules'
import { buildBehavior } from '../domain/build-behavior'
import { createTestLocalData, TEST_GAME_SETUP_REVISION_ID } from '../domain/test-helpers'
import { GameRuleDetails } from './GameRuleDetails'

const setup = createTestLocalData().gameSetups[TEST_GAME_SETUP_REVISION_ID]!
const draft = { ...buildBehavior(setup), ppLimit: setup.ppLimit ?? { state: 'unknown' as const } }
const rules = resolveGameRules(setup, [])

describe('selected calculation profile details', () => {
  it('retains an unavailable saved profile without showing a native fallback', () => {
    const markup = renderToStaticMarkup(<GameRuleDetails calculation={{ ...defaultCalculation(null), genderSelection: { version: 1, id: 900 } }} draft={draft} legacyRules={false} rules={rules}/>)
    expect(markup).toContain('Unavailable gender #900')
    expect(markup).toContain('Its totals remain unknown')
    expect(markup).not.toContain('Selected bonus profile</h4><strong>Male')
  })

  it('labels an unspecified profile as a comparison baseline', () => {
    const markup = renderToStaticMarkup(<GameRuleDetails calculation={defaultCalculation(null)} draft={draft} legacyRules={false} rules={rules}/>)
    expect(markup).toContain('No-bonus comparison baseline')
    expect(markup).not.toContain('Its totals remain unknown')
  })
})
