export const COPPER_PER_SILVER = 100
export const SILVER_PER_GOLD = 100
export const COIN_VALUES = Object.freeze({
  gold: COPPER_PER_SILVER * SILVER_PER_GOLD,
  silver: COPPER_PER_SILVER,
  copper: 1,
})
export type Coin = keyof typeof COIN_VALUES
const COINS: readonly Coin[] = ['gold', 'silver', 'copper']

export interface CoinAmount {
  readonly coin: Coin
  readonly amount: number
}

export type MoneyTextPart = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'money'; readonly copper: number }

const MONEY_TOKEN = /(?<![\w.,+\-\u2212])(\d{1,3}(?:,\d{3})+|\d+)[ \t\u00a0]+(gold|silver|copper)\b/gi
const HORIZONTAL_SPACE = /^[ \t\u00a0]+$/
const SIGN_PREFIX = /[\-\u2212][ \t\u00a0]*$/
// A metal adjective in an item name does not establish a currency amount
const METAL_ITEM_SUFFIX = /^[ \t\u00a0]+(?:armor|axe|book|bow|cap|cape|crown|dagger|dust|helm|helmet|ingot|katana|mail|ore|pages|rapier|ring|robe|scythe|shield|spear|staff|suit|sword|vest|wand)s?\b/i

export function coinAmounts(copper: number): readonly CoinAmount[] {
  if (!Number.isSafeInteger(copper) || copper < 0) throw new RangeError('Money requires a nonnegative safe integer copper amount')
  let remaining = copper
  const result: CoinAmount[] = []
  for (const coin of COINS) {
    const amount = Math.floor(remaining / COIN_VALUES[coin])
    if (amount > 0) result.push({ coin, amount })
    remaining %= COIN_VALUES[coin]
  }
  return result.length ? result : [{ coin: 'copper', amount: 0 }]
}

export function moneyTextParts(text: string): readonly MoneyTextPart[] {
  const tokens = [...text.matchAll(MONEY_TOKEN)].flatMap(match => {
    const end = match.index + match[0].length
    const coin = match[2].toLowerCase() as Coin
    const copper = Number(match[1].replaceAll(',', '')) * COIN_VALUES[coin]
    if (!Number.isSafeInteger(copper) || SIGN_PREFIX.test(text.slice(0, match.index)) || METAL_ITEM_SUFFIX.test(text.slice(end))) return []
    return [{ start: match.index, end, coin, copper }]
  })
  const parts: MoneyTextPart[] = []
  let cursor = 0
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.start > cursor) parts.push({ kind: 'text', text: text.slice(cursor, token.start) })
    let { copper, end, coin } = token
    let next = tokens[index + 1]
    while (next && HORIZONTAL_SPACE.test(text.slice(end, next.start)) && COIN_VALUES[next.coin] < COIN_VALUES[coin] && Number.isSafeInteger(copper + next.copper)) {
      copper += next.copper
      end = next.end
      coin = next.coin
      index += 1
      next = tokens[index + 1]
    }
    parts.push({ kind: 'money', copper })
    cursor = end
  }
  if (cursor < text.length) parts.push({ kind: 'text', text: text.slice(cursor) })
  return parts
}

export function moneyTextLabel(text: string): string {
  return moneyTextParts(text).map(part => part.kind === 'text' ? part.text : coinAmounts(part.copper).map(({ coin, amount }) => `${amount} ${coin}`).join(', ')).join('')
}
