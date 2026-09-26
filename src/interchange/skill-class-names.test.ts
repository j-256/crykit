import { describe, expect, it } from 'vitest'
import { matchScreenshotClassName } from './skill-class-names'

const ninja = { id: 'ninja', name: 'Ninja' }
const choices = [ninja, { id: 'monk', name: 'Monk' }, { id: 'nomad', name: 'Nomad' }, { id: 'wizard', name: 'Wizard' }]

describe('screenshot class-name recognition', () => {
  it.each(['Ninja', 'nInJa', ' Ninja '])('keeps the exact class identity for %j', text => {
    expect(matchScreenshotClassName(choices, text)).toEqual({ kind: 'exact', choice: ninja })
  })

  it.each(['Nin ja', 'N i n j a', '\uff2e\uff49\uff4e\uff4a\uff41'])('normalizes spacing and character width in %j', text => {
    expect(matchScreenshotClassName(choices, text)).toEqual({ kind: 'normalized', choice: ninja })
  })

  it.each(['Min ja', 'Ninj', 'Ninija'])('recognizes a unique class after one character error in %j', text => {
    expect(matchScreenshotClassName(choices, text)).toEqual({ kind: 'approximate', choice: ninja })
  })

  it('prefers a normalized exact match over nearby names', () => {
    const minja = { id: 'minja', name: 'Minja' }
    expect(matchScreenshotClassName([...choices, minja], 'Min ja')).toEqual({ kind: 'normalized', choice: minja })
  })

  it('keeps equally close class names unresolved regardless of their order', () => {
    const minka = { id: 'minka', name: 'Minka' }
    expect(matchScreenshotClassName([ninja, minka], 'Min ja')).toEqual({ kind: 'ambiguous' })
    expect(matchScreenshotClassName([minka, ninja], 'Min ja')).toEqual({ kind: 'ambiguous' })
  })

  it('does not collapse distinct class identities with the same normalized name', () => {
    expect(matchScreenshotClassName([ninja, { id: 'other-ninja', name: 'Ninja' }], 'Ninja')).toEqual({ kind: 'ambiguous' })
    expect(matchScreenshotClassName([ninja, { id: 'spaced-ninja', name: 'Nin ja' }], 'Ninja')).toEqual({ kind: 'ambiguous' })
  })

  it.each([undefined, '', ' ', 'Nin', 'Nijna', 'Knight', 'Ninja!!'])('leaves missing, short, or unrelated text %j unresolved', text => {
    expect(matchScreenshotClassName(choices, text)).toEqual({ kind: 'unrecognized' })
  })

  it('matches only available choices', () => {
    expect(matchScreenshotClassName([], 'Ninja')).toEqual({ kind: 'unrecognized' })
    expect(matchScreenshotClassName(choices.filter(choice => choice !== ninja), 'Min ja')).toEqual({ kind: 'unrecognized' })
  })
})
