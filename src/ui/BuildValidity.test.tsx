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
    expect(markup).toContain('Equipment and passive-point checks')
  })
})
