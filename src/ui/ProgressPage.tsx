import type { ReactNode } from 'react'
import { nativeUiArtwork } from '../catalog/sprites'
import { ScreenHeader } from './components'
import { Icon } from './icons'
import type { PROGRESS_PAGES } from './navigation'
import { ProgressBoards } from './ProgressBoards'
import './progress-page.css'

type ProgressVariant = typeof PROGRESS_PAGES[number]['segment']
const classSealUrl = nativeUiArtwork('classSeal')?.url

const VARIANTS: Readonly<Record<ProgressVariant, {
  readonly title: string
  readonly eyebrow: string
  readonly description: string
  readonly icon: ReactNode
  readonly summaryLabel: string
  readonly countLabel: string
}>> = {
  seals: {
    title: 'Progress',
    eyebrow: 'Class mastery seals',
    description: 'Track each vanilla class from crystal unlock through mastery-seal collection for this playthrough.',
    icon: <img alt="" decoding="async" src={classSealUrl}/>,
    summaryLabel: 'Class mastery seal totals',
    countLabel: 'Seals acquired',
  },
  unlocks: {
    title: 'Progress',
    eyebrow: 'Travel & unlocks',
    description: 'Track acquired mount instruments, reusable shrine stones, and capability items for this Playthrough.',
    icon: <Icon name="compass"/>,
    summaryLabel: 'Travel and unlock totals',
    countLabel: 'Items acquired',
  },
  summons: {
    title: 'Progress',
    eyebrow: 'Summons',
    description: 'Track Summoner skill unlocks for this Playthrough in the shape of the in-game skill tree.',
    icon: <Icon name="spark"/>,
    summaryLabel: 'Summon unlock totals',
    countLabel: 'Summons unlocked',
  },
  quintar: {
    title: 'Quintar breeding',
    eyebrow: 'Golden Quintar guide',
    description: 'A step-by-step route from wild eggs to your Golden Quintar. Click each tile when you finish it in the game.',
    icon: <Icon name="ring"/>,
    summaryLabel: 'Quintar breeding progress',
    countLabel: 'Steps complete',
  },
}

export function ProgressPage({ variant, count, total, actions, notices, summaryIcon, summaryNote, summaryDetails, children }: {
  readonly variant: ProgressVariant
  readonly count: number
  readonly total: number
  readonly actions?: ReactNode
  readonly notices?: ReactNode
  readonly summaryIcon?: ReactNode
  readonly summaryNote?: ReactNode
  readonly summaryDetails?: ReactNode
  readonly children: ReactNode
}) {
  const details = VARIANTS[variant]
  return <>
    <ScreenHeader actions={actions} description={details.description} eyebrow={details.eyebrow} title={details.title}/>
    <ProgressBoards activeSegment={variant}/>
    {notices}
    <section aria-label={details.summaryLabel} className="progress-summary">
      <div aria-live="polite" className="progress-summary__primary"><span aria-hidden="true" className="progress-summary__icon">{summaryIcon ?? details.icon}</span><div><div className="progress-summary__number"><strong>{count}</strong><span> / {total}</span></div><p>{details.countLabel}</p>{summaryNote && <small>{summaryNote}</small>}</div></div>
      {summaryDetails}
    </section>
    {children}
  </>
}
