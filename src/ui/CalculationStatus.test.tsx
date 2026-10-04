import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CalculationStatus } from './CalculationStatus'

describe('calculation recovery guidance', () => {
  it('explains unsupported battle effects and keeps unavailable setup actions out of the recovery path', () => {
    const markup = renderToStaticMarkup(<CalculationStatus issues={['Ambush Knife: automatic battle-start status "Ambush" cannot be calculated by the resting-stat preview.']} partial onReviewGameSetup={() => undefined}/>)
    expect(markup).toContain('Totals unavailable')
    expect(markup).toContain('Battle-state inputs are not available in this preview')
    expect(markup).toContain('try an item or passive without automatic battle-start status effects')
    expect(markup).not.toMatch(/Complete the calculation inputs|Review Game Setup|StatusAuto/)
  })

  it('retains the Game Setup recovery action for setup problems', () => {
    const markup = renderToStaticMarkup(<CalculationStatus issues={['Game platform is unknown.']} onReviewGameSetup={() => undefined}/>)
    expect(markup).toContain('Review Game Setup')
    expect(markup).not.toContain('Battle-state inputs')
  })
})
