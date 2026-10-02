import { useState } from 'react'
import { coinAmounts, moneyTextParts, type Coin } from '../domain/money'
import { nativeUiArtwork } from '../catalog/sprites'

const COIN_URLS: Readonly<Record<Coin, string | undefined>> = Object.freeze({ gold: nativeUiArtwork('goldCoin')?.url, silver: nativeUiArtwork('silverCoin')?.url, copper: nativeUiArtwork('copperCoin')?.url })
const COIN_ICON_WIDTH = 12
const COIN_ICON_HEIGHT = 14

function CoinIcon({ coin }: { coin: Coin }) {
  const [failed, setFailed] = useState(false)
  const url = COIN_URLS[coin]
  return failed || !url ? <span className="money-coin__fallback">{coin}</span> : <img alt="" draggable={false} height={COIN_ICON_HEIGHT} onError={() => setFailed(true)} src={url} width={COIN_ICON_WIDTH}/>
}

export function Money({ copper }: { copper: number }) {
  const coins = coinAmounts(copper)
  const label = coins.map(({ coin, amount }) => `${amount} ${coin}`).join(', ')
  return <span aria-label={label} className="money-amount" role="img" title={label}>{coins.map(({ coin, amount }) => <span aria-hidden="true" className="money-coin" data-coin={coin} key={coin}>{amount}<CoinIcon coin={coin}/></span>)}</span>
}

export function MoneyText({ children }: { children: string }) {
  return <>{moneyTextParts(children).map((part, index) => part.kind === 'text' ? part.text : <Money copper={part.copper} key={index}/>)}</>
}
