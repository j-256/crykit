import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { validateBuildContent } from '../domain/build-validity'
import { BuildValidity } from './BuildValidity'

const report = validateBuildContent({ primaryClass: null, secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [] }, undefined, [], () => undefined)

describe('Build draft and compatibility feedback', () => {
  it('does not turn an empty compatible draft into a green completed Build', () => {
    const markup = renderToStaticMarkup(<BuildValidity hasPrimaryClass={false} report={{ ...report, status: 'valid', issues: [] }}/>)
    expect(markup).toContain('data-status="draft"')
    expect(markup).toContain('Choose a class')
    expect(markup).not.toContain('No known loadout conflicts')
  })

  it('keeps compatibility separate from optional empty equipment', () => {
    const markup = renderToStaticMarkup(<BuildValidity hasPrimaryClass report={{ ...report, status: 'valid', issues: [] }}/>)
    expect(markup).toContain('data-status="valid"')
    expect(markup).toContain('No known loadout conflicts')
    expect(markup).not.toContain('Equipment and passive-point checks')
    expect(markup).not.toContain('validation-issues')
    expect(markup).not.toContain('draft')
  })

  it('keeps actionable conflicts and their review controls expanded', () => {
    const markup = renderToStaticMarkup(<BuildValidity fieldLabels={{ body: 'Body' }} onReviewField={() => undefined} report={{ ...report, status: 'invalid', issues: [{ code: 'EQUIPMENT_PERMISSION', status: 'invalid', message: 'This class cannot equip the selected armor', slotId: 'body' }] }}/>)
    expect(markup).toContain('Build needs changes')
    expect(markup).toContain('This class cannot equip the selected armor')
    expect(markup).toContain('Review Body')
  })

  it('points unresolved permissions to their class and passive inputs and offers source recovery', () => {
    const markup = renderToStaticMarkup(<BuildValidity onReviewField={() => undefined} onUploadMod={() => undefined} report={{ ...report, status: 'undetermined', issues: [{ code: 'CLASS_EQUIPMENT_PERMISSION', status: 'undetermined', message: 'Dagger permission is unresolved', slotId: 'main-hand' }] }}/>)
    expect(markup).toContain('Upload mod JSON')
    expect(markup).toContain('Review Class')
    expect(markup).toContain('Review passives')
    expect(markup).toContain('Restore the missing class and passive definitions')
  })

  it('provides a passive recovery action even when the PP warning has no single slot', () => {
    const markup = renderToStaticMarkup(<BuildValidity onReviewField={() => undefined} onUploadMod={() => undefined} report={{ ...report, status: 'undetermined', issues: [{ code: 'PP_COST_UNKNOWN', status: 'undetermined', message: 'Selected passive costs are unresolved' }] }}/>)
    expect(markup).toContain('Review passives')
    expect(markup).toContain('Upload mod JSON')
  })

  it('offers JSON recovery for a specific unavailable innate effect or equipped-passive fact', () => {
    for (const code of ['CLASS_INNATE_DEFINITION', 'PASSIVE_LEARNABILITY_UNKNOWN']) {
      const markup = renderToStaticMarkup(<BuildValidity onReviewField={() => undefined} onUploadMod={() => undefined} report={{ ...report, status: 'undetermined', issues: [{ code, status: 'undetermined', message: 'Synthetic unavailable active fact', slotId: code === 'CLASS_INNATE_DEFINITION' ? 'primary-class' : 'passive-1' }] }}/>)
      expect(markup).toContain('Upload mod JSON')
      expect(markup).toContain(code === 'CLASS_INNATE_DEFINITION' ? 'active innates' : 'this passive can be learned')
    }
  })

  it('routes unknown setup rules to settings without promising a JSON import will fix them', () => {
    const markup = renderToStaticMarkup(<BuildValidity onReviewSetup={() => undefined} onUploadMod={() => undefined} report={{ ...report, status: 'undetermined', issues: [{ code: 'PP_LIMIT_UNKNOWN', status: 'undetermined', message: 'The PP limit is unknown' }] }}/>)
    expect(markup).toContain('Review Game Setup')
    expect(markup).toContain('supply the value for your game')
    expect(markup).not.toContain('Upload mod JSON')
  })

  it('explains how to change invalid selections in a read-only share', () => {
    const markup = renderToStaticMarkup(<BuildValidity readOnly onReviewField={() => undefined} report={{ ...report, status: 'invalid', issues: [{ code: 'DUPLICATE_PASSIVE', status: 'invalid', message: 'Passive selected twice', slotId: 'passive-1' }] }}/>)
    expect(markup).toContain('Remove or replace the repeated passive')
    expect(markup).toContain('Save a copy to change selections or rules')
    expect(markup).toContain('Inspect selection')
  })
})
