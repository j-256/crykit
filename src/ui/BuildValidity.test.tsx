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
    expect(markup).not.toContain('No known compatibility conflicts')
  })

  it('keeps compatibility separate from optional empty equipment', () => {
    const markup = renderToStaticMarkup(<BuildValidity hasPrimaryClass report={{ ...report, status: 'valid', issues: [] }}/>)
    expect(markup).toContain('data-status="valid"')
    expect(markup).toContain('No known compatibility conflicts')
    expect(markup).not.toContain('draft')
  })
})
