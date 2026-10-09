import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CalculationStatus } from './CalculationStatus'

describe('calculation recovery guidance', () => {
  it('offers source import beside locked calculations and retains other input guidance', () => {
    const markup = renderToStaticMarkup(<CalculationStatus issues={['An enabled mod revision is unavailable.', 'An enabled mod revision is unavailable.', 'Growth allocation is incomplete.']} partial onUploadMod={() => undefined} onReviewGameSetup={() => undefined}/>)
    expect(markup).toContain('Calculations need mod JSON')
    expect(markup).toContain('Upload mod JSON')
    expect(markup).toContain('Known values stay visible')
    expect(markup).toContain('Growth allocation is incomplete')
    expect(markup).toContain('Review Game Setup')
    expect(markup.match(/An enabled mod revision is unavailable\./g)).toHaveLength(1)
    expect(markup).not.toContain('notice--warning')
  })
  it('retains the actual missing input and available components for battle scenarios', () => {
    const markup = renderToStaticMarkup(<CalculationStatus issues={['Ambush status presence is uncertain.']} partial onReviewGameSetup={() => undefined}/>)
    expect(markup).toContain('Totals unavailable')
    expect(markup).toContain('Ambush status presence is uncertain.')
    expect(markup).toContain("Known values are shown below.")
    expect(markup).toContain('Review Game Setup')
    expect(markup).not.toContain('Battle-state inputs are not available')
  })

  it('retains the Game Setup recovery action for setup problems', () => {
    const markup = renderToStaticMarkup(<CalculationStatus issues={['Game platform is unknown.']} onReviewGameSetup={() => undefined}/>)
    expect(markup).toContain('Review Game Setup')
    expect(markup).not.toContain('Battle-state inputs')
  })
})
