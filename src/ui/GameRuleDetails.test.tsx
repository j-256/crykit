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
  it('keeps native profile and difficulty facts visible without source markers', () => {
    const current = resolveGameRules({ mode: { state: 'known', value: 'Standard' }, difficulty: { version: 1, selection: { state: 'known', value: 2 } } }, [])
    const markup = renderToStaticMarkup(<GameRuleDetails calculation={{ ...defaultCalculation(null), gender: 'male' }} draft={draft} legacyRules={false} rules={current}/>)
    expect(markup).toContain('Bonus stats: HP, SPI, LUK')
    expect(markup).toContain('<h4>Base game</h4>')
    expect(markup).toContain('Enemy HP: 130%. Boss HP: 130%')
    expect(markup).not.toContain('sources-trigger')
    expect(markup).not.toContain('Source:')
    const uncertain = renderToStaticMarkup(<GameRuleDetails calculation={{ ...defaultCalculation(null), gender: 'male' }} draft={draft} legacyRules={false} rules={{ ...current, issues: ['Synthetic unsupported platform'], difficultyIssues: ['Synthetic unsupported platform'] }}/>)
    expect(uncertain).toContain('Sources for Male bonus profile')
    expect(uncertain).toContain('Sources for Hard difficulty')
    expect(uncertain).toContain('Synthetic unsupported platform')
  })

  it('preserves external profile evidence even when a mod name matches a native source label', () => {
    const native = resolveGameRules(undefined, [])
    const male = native.genders.find(gender => gender.id === 0)!
    const difficulty = native.difficulties.find(value => value.name === 'Hard')!
    const current = { ...native, genders: [{ ...male, sourceKind: 'mod' as const }], difficulty: { ...difficulty, sourceKind: 'mod' as const } }
    const markup = renderToStaticMarkup(<GameRuleDetails calculation={{ ...defaultCalculation(null), gender: 'male' }} draft={draft} legacyRules={false} rules={current}/>)
    expect(markup).toContain('Sources for Male bonus profile')
    expect(markup).toContain('Sources for Hard difficulty')
    expect(markup).toContain('Bonus stats: HP, SPI, LUK')
    const localized = { ...native, genders: [{ ...male, name: 'Synthetic localized name', nameSource: 'Synthetic labels' }] }
    const translated = renderToStaticMarkup(<GameRuleDetails calculation={{ ...defaultCalculation(null), gender: 'male' }} draft={draft} legacyRules={false} rules={localized}/>)
    expect(translated).toContain('Sources for Synthetic localized name bonus profile')
    expect(translated).toContain('Bonus stats: HP, SPI, LUK')
  })

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
