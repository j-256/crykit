import { useState } from 'react'
import { coinAmounts, moneyTextParts, type Coin } from '../domain/money'
import goldCoinUrl from '../assets/coins/gold-coin.png?url&no-inline'
import silverCoinUrl from '../assets/coins/silver-coin.png?url&no-inline'
import copperCoinUrl from '../assets/coins/copper-coin.png?url&no-inline'

const COIN_URLS: Readonly<Record<Coin, string>> = Object.freeze({ gold: goldCoinUrl, silver: silverCoinUrl, copper: copperCoinUrl })

function CoinIcon({ coin }: { coin: Coin }) {
  const [failed, setFailed] = useState(false)
  return failed ? <span className="money-coin__fallback">{coin}</span> : <img alt="" draggable={false} height={14} onError={() => setFailed(true)} src={COIN_URLS[coin]} width={11}/>
}

export function Money({ copper }: { copper: number }) {
  const coins = coinAmounts(copper)
  const label = coins.map(({ coin, amount }) => `${amount} ${coin}`).join(', ')
  return <span aria-label={label} className="money-amount" role="img" title={label}>{coins.map(({ coin, amount }) => <span aria-hidden="true" className="money-coin" data-coin={coin} key={coin}>{amount}<CoinIcon coin={coin}/></span>)}</span>
}

export function MoneyText({ children }: { children: string }) {
  return <>{moneyTextParts(children).map((part, index) => part.kind === 'text' ? part.text : <Money copper={part.copper} key={index}/>)}</>
}
