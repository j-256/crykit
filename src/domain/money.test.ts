import { describe, expect, it } from 'vitest'
import { coinAmounts, moneyTextLabel, moneyTextParts } from './money'

describe('in-game coin denominations', () => {
  it.each([
    [0, [{ coin: 'copper', amount: 0 }]],
    [99, [{ coin: 'copper', amount: 99 }]],
    [100, [{ coin: 'silver', amount: 1 }]],
    [1000, [{ coin: 'silver', amount: 10 }]],
    [9999, [{ coin: 'silver', amount: 99 }, { coin: 'copper', amount: 99 }]],
    [10000, [{ coin: 'gold', amount: 1 }]],
    [10250, [{ coin: 'gold', amount: 1 }, { coin: 'silver', amount: 2 }, { coin: 'copper', amount: 50 }]],
    [10001, [{ coin: 'gold', amount: 1 }, { coin: 'copper', amount: 1 }]],
    [35000, [{ coin: 'gold', amount: 3 }, { coin: 'silver', amount: 50 }]],
    [Number.MAX_SAFE_INTEGER, [{ coin: 'gold', amount: 900719925474 }, { coin: 'silver', amount: 9 }, { coin: 'copper', amount: 91 }]],
  ])('splits %i copper without zero denominations or rounding', (copper, expected) => {
    expect(coinAmounts(copper as number)).toEqual(expected)
  })

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects unsupported numeric amounts: %s', copper => {
    expect(() => coinAmounts(copper)).toThrow(RangeError)
  })
})

describe('currency embedded in source text', () => {
  it('normalizes copper, silver, gold, and adjacent mixed denominations', () => {
    expect(moneyTextParts('1,000 Copper; 760 Silver; 2 Gold 50 Silver 5 Copper')).toEqual([
      { kind: 'money', copper: 1000 }, { kind: 'text', text: '; ' },
      { kind: 'money', copper: 76000 }, { kind: 'text', text: '; ' },
      { kind: 'money', copper: 25005 },
    ])
  })

  it('preserves prose, line breaks, alternatives, and separate prices', () => {
    expect(moneyTextParts('Costs 10 copper each or 2 silver.\n1 gold\n50 silver')).toEqual([
      { kind: 'text', text: 'Costs ' }, { kind: 'money', copper: 10 },
      { kind: 'text', text: ' each or ' }, { kind: 'money', copper: 200 },
      { kind: 'text', text: '.\n' }, { kind: 'money', copper: 10000 },
      { kind: 'text', text: '\n' }, { kind: 'money', copper: 5000 },
    ])
    expect(moneyTextParts('1 copper 2 copper')).toEqual([
      { kind: 'money', copper: 1 }, { kind: 'text', text: ' ' }, { kind: 'money', copper: 2 },
    ])
  })

  it.each([
    'Unknown', 'Copper Helm', '3 Gold Ore', '2 silver ingots', '12 Copper Suits',
    '6 MP, 10 CT, 1000 LP', '1.5 gold', '-1000 copper', '- 1000 copper', '+1000 silver',
    '1,00 copper', '1234,567 copper', '1e3 copper', '1000 coppers',
    '9007199254740992 copper', '90071992547410 silver',
  ])('keeps noncurrency and unsupported values unchanged: %s', text => {
    expect(moneyTextParts(text)).toEqual([{ kind: 'text', text }])
  })

  it('keeps material quantities beside a valid price', () => {
    expect(moneyTextParts('3 Gold Ore + 1000 copper')).toEqual([
      { kind: 'text', text: '3 Gold Ore + ' }, { kind: 'money', copper: 1000 },
    ])
    expect(moneyTextParts('3 Gold Ore, 1000 copper')).toEqual([
      { kind: 'text', text: '3 Gold Ore, ' }, { kind: 'money', copper: 1000 },
    ])
  })

  it('provides the same normalized denominations for text-only tooltips', () => {
    expect(moneyTextLabel('Costs 10,250 Copper each.')).toBe('Costs 1 gold, 2 silver, 50 copper each.')
  })
})
