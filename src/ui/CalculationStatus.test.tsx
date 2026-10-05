import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CalculationStatus } from './CalculationStatus'

describe('calculation recovery guidance', () => {
  it('retains the actual missing input and available components for battle scenarios', () => {
    const markup = renderToStaticMarkup(<CalculationStatus issues={['Ambush status presence is uncertain.']} partial onReviewGameSetup={() => undefined}/>)
    expect(markup).toContain('Totals unavailable')
    expect(markup).toContain('Ambush status presence is uncertain.')
    expect(markup).toContain('Available components are shown below')
    expect(markup).toContain('Review Game Setup')
    expect(markup).not.toContain('Battle-state inputs are not available')
  })

  it('retains the Game Setup recovery action for setup problems', () => {
    const markup = renderToStaticMarkup(<CalculationStatus issues={['Game platform is unknown.']} onReviewGameSetup={() => undefined}/>)
    expect(markup).toContain('Review Game Setup')
    expect(markup).not.toContain('Battle-state inputs')
  })
})
