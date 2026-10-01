import { memo, useCallback, useState } from 'react'
import { BUNDLED_CATALOG_REVISION_ID } from '../catalog/bundled-catalog'
import { QUINTAR_BREEDING_STEPS, QUINTAR_GUIDE_SOURCE, QUINTAR_NURSERY_CAPACITY, QUINTAR_PHASES, QUINTAR_RACING_SOURCE, QUINTAR_STEP, quintarParentsAfterStep, quintarRaceRequirements, type QuintarBreedingStep, type QuintarBreedingStepId } from '../catalog/quintar-breeding'
import { QUINTAR_STEP_REFERENCES } from '../catalog/quintar-references'
import { quintarGuideArtwork, type QuintarGuideArtworkKey } from '../catalog/sprites'
import { STARTER_CATALOG_ID } from '../catalog/starter'
import { requirePlaythrough } from '../domain/core'
import type { CatalogSnapshot, EntityId, LocalData } from '../domain/types'
import { Button, InlineNotice, ScreenHeader } from './components'
import { Icon, type IconName } from './icons'
import { MoneyText } from './MoneyText'
import { ProgressBoards } from './ProgressBoards'
import { ReferenceLink } from './ReferenceLink'
import { useQueuedTileUpdates } from './useQueuedTileUpdates'
import './quintar-breeding.css'

const PHASE_ICONS: Readonly<Record<QuintarBreedingStep['phase'], IconName>> = Object.freeze({ unlock: 'compass', capture: 'egg', aqua: 'egg', black: 'egg', gold: 'ring' })
const STEP_ARTWORK: Readonly<Partial<Record<QuintarBreedingStepId, QuintarGuideArtworkKey>>> = Object.freeze({
  [QUINTAR_STEP.babel]: 'babel',
  [QUINTAR_STEP.ocarina]: 'ocarina',
  [QUINTAR_STEP.trustyBlue]: 'trustyBlue',
  [QUINTAR_STEP.trustyRed]: 'trustyRed',
  [QUINTAR_STEP.wokeRiver]: 'wokeRiver',
  [QUINTAR_STEP.brutishDesert]: 'brutishDesert',
  [QUINTAR_STEP.golden]: 'golden',
  [QUINTAR_STEP.summon]: 'golden',
})

const QuintarStepTile = memo(function QuintarStepTile({ step, number, complete, next, pending, missingParents, catalog, onToggle }: {
  readonly step: QuintarBreedingStep
  readonly number: number
  readonly complete: boolean
  readonly next: boolean
  readonly pending: boolean
  readonly missingParents: string
  readonly catalog?: CatalogSnapshot
  readonly onToggle: (stepId: QuintarBreedingStepId, complete: boolean) => void
}) {
  const races = quintarRaceRequirements(step)
  const parents = quintarParentsAfterStep(step)
  const [artworkFailed, setArtworkFailed] = useState(false)
  const artworkKey = STEP_ARTWORK[step.id] ?? (step.parents ? 'egg' : undefined)
  const artwork = artworkKey && quintarGuideArtwork(artworkKey)
  const references = QUINTAR_STEP_REFERENCES[step.id].filter(target => catalog?.entities[target.entityId]?.kind === target.kind)
  return <article aria-busy={pending || undefined} className="quintar-tile" data-complete={complete} data-next={next || undefined} data-step={step.id} data-type={step.result?.type}>
    <button aria-label={`Step ${number}: ${step.title}. ${complete ? 'Mark incomplete' : 'Mark complete'}`} aria-pressed={complete} className="quintar-tile__toggle" id={`quintar-step-${step.id}`} onClick={() => onToggle(step.id, complete)} type="button">
      <span className="quintar-tile__top"><span className="quintar-tile__number">{String(number).padStart(2, '0')}</span><span className="quintar-tile__status">{complete ? 'Complete' : next ? 'Next step' : 'Not marked'}</span><span aria-hidden="true" className="quintar-tile__check">{complete ? <Icon name="check"/> : <span/>}</span></span>
      <span aria-hidden="true" className="quintar-tile__art">{artwork && !artworkFailed ? <img alt="" decoding="async" height={artwork.asset.height} loading="lazy" onError={() => setArtworkFailed(true)} src={artwork.url} width={artwork.asset.width}/> : <Icon name={PHASE_ICONS[step.phase]}/>}{step.result && <span>{step.result.type}</span>}</span>
      <strong>{step.title}</strong>
      <small>{complete ? 'Click to undo' : 'Click when done'}</small>
    </button>
    <div className="quintar-tile__guide">
      {step.parents && <p className="quintar-tile__pair"><strong>{step.parents[0].name}</strong><span role="img" aria-label="paired with">+</span><strong>{step.parents[1].name}</strong></p>}
      <p><MoneyText>{step.instruction}</MoneyText></p>
      {races.length > 0 && <div className="quintar-tile__races"><span>Race wins before breeding</span>{races.map(parent => <p key={parent.name}><strong>{parent.name}</strong><span>{parent.wins === undefined ? 'Requirement unknown' : parent.wins === 0 ? 'No wins required' : `${parent.wins} different tracks total`}</span></p>)}</div>}
      {parents.keep.length > 0 && <p className="quintar-tile__keep"><strong>Keep:</strong> {parents.keep.join(' and ')} for later pairings.</p>}
      {parents.release.length > 0 && <p className="quintar-tile__release"><strong>After hatching:</strong> {parents.release.join(' and ')} can be released for this route.</p>}
      {missingParents && <p className="quintar-tile__missing">Prerequisites not marked: {missingParents}.</p>}
      {catalog && references.length > 0 && <nav aria-label={`Reference pages for ${step.title}`} className="quintar-tile__refs"><span>Reference:</span>{references.map(target => <ReferenceLink key={target.entityId} refValue={{ kind: 'catalog', catalogId: catalog.id, catalogRevisionId: catalog.revisionId, entityId: target.entityId as EntityId }}>{target.label ?? catalog.entities[target.entityId].name}</ReferenceLink>)}</nav>}
    </div>
  </article>
})

export function QuintarBreedingView({ localData, catalogs, onToggle }: {
  readonly localData: LocalData
  readonly catalogs: readonly CatalogSnapshot[]
  readonly onToggle: (stepId: QuintarBreedingStepId) => Promise<void>
}) {
  const playthrough = requirePlaythrough(localData)
  const referenceCatalog = catalogs.find(catalog => catalog.id === STARTER_CATALOG_ID && catalog.revisionId === BUNDLED_CATALOG_REVISION_ID)
    ?? catalogs.findLast(catalog => catalog.id === STARTER_CATALOG_ID)
  const completed = playthrough.quintarBreeding
  const { queuedUpdates, enqueue } = useQueuedTileUpdates<QuintarBreedingStepId, boolean>()
  const [failure, setFailure] = useState<{ readonly stepId: QuintarBreedingStepId; readonly message: string }>()
  const isComplete = (stepId: QuintarBreedingStepId) => queuedUpdates.get(stepId)?.state ?? Boolean(completed && Object.hasOwn(completed, stepId))
  const completeCount = QUINTAR_BREEDING_STEPS.filter(step => isComplete(step.id)).length
  const nextStep = QUINTAR_BREEDING_STEPS.find(step => !isComplete(step.id))
  const toggle = useCallback((stepId: QuintarBreedingStepId, complete: boolean) => {
    setFailure(undefined)
    enqueue(stepId, complete, state => !state, () => onToggle(stepId), (reason) => {
      setFailure(current => current ?? { stepId, message: reason instanceof Error ? reason.message : 'The step could not be saved.' })
    })
  }, [enqueue, onToggle])
  const focusNextStep = () => {
    if (!nextStep) return
    const button = document.getElementById(`quintar-step-${nextStep.id}`)
    button?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    button?.focus({ preventScroll: true })
  }
  return <>
    <ScreenHeader description="A step-by-step route from wild eggs to your Golden Quintar. Click each tile when you finish it in the game." eyebrow="Golden Quintar guide" title="Quintar breeding"/>
    <ProgressBoards/>
    {failure && <InlineNotice title="Step not saved" tone="danger">{failure.message} After queued clicks finish, the tile shows its saved state. <Button disabled={queuedUpdates.has(failure.stepId)} onClick={() => toggle(failure.stepId, isComplete(failure.stepId))} tone="secondary">Retry step</Button></InlineNotice>}
    <section aria-label="Quintar breeding progress" className="quintar-summary">
      <div className="quintar-summary__count" aria-live="polite"><Icon name="ring"/><div><strong>{completeCount}<span> / {QUINTAR_BREEDING_STEPS.length}</span></strong><p>Steps complete</p></div></div>
      <div className="quintar-summary__next"><span>{nextStep ? 'Next unmarked step' : 'Guide complete'}</span><strong>{nextStep?.title ?? 'Your Golden Quintar route is complete!'}</strong><p>{nextStep ? 'You can mark steps in any order. Only the tile you click changes.' : 'Click any completed tile to undo its mark.'}</p>{nextStep && <Button onClick={focusNextStep} tone="secondary">Go to next step</Button>}</div>
    </section>
    <details className="quintar-tips">
      <summary>Breeding tips & sources</summary>
      <div>
        <p><strong>Before every pairing:</strong> both parents must show Happy! and the nursery needs an empty slot. It holds {QUINTAR_NURSERY_CAPACITY} quintars. Berries improve mood; cheese helps with exhaustion. Hatch each egg with an Incubator before marking its step complete.</p>
        <p><strong>Race wins are cumulative:</strong> the listed total is for that individual quintar on different tracks. Repeating the same track does not add another distinct win. Each parent's requirement depends on its partner's type.</p>
        <p><strong>Release advice follows this route:</strong> hatch the child first, keep every parent needed by a later pairing, and keep any quintar you want for another purpose. Marks record completed actions, not your current nursery roster or inventory.</p>
        <p><strong>Reference links:</strong> The tiles link to exact bundled entries for items, wild quintars, eggs, and documented places. Individual bred variants have no separate entries in the bundled Reference, so their tiles link to the breeding method and egg instead.</p>
        <p>The pairings follow <a href={QUINTAR_GUIDE_SOURCE} rel="noreferrer" target="_blank">the wiki's Method 2</a>. Capture directions also use the bundled monster entries. Race totals follow <a href={QUINTAR_RACING_SOURCE} rel="noreferrer" target="_blank">Respwner's breeding guide</a>, which notes Black's reduction to three partner wins. <a href="https://crystal-project.fandom.com/wiki/Quintar_Shop?oldid=13165" rel="noreferrer" target="_blank">Shop prices</a> are community documentation. Switch and mod applicability remain unverified.</p>
        <p>Windows 1.6.9 requires one partner win for Desert and Highland; this community route recommends two. River, Black, and Aqua thresholds agree with the inspected code. Switch and mod thresholds remain unverified.</p>
      </div>
    </details>
    <div className="quintar-guide">{QUINTAR_PHASES.map(phase => {
      const steps = QUINTAR_BREEDING_STEPS.filter(step => step.phase === phase.id)
      const count = steps.filter(step => isComplete(step.id)).length
      return <section aria-label={phase.title} className="quintar-phase" key={phase.id}>
        <header><div><h2>{phase.title}</h2><p>{phase.description}</p></div><span>{count} / {steps.length}</span></header>
        <div className="quintar-board">{steps.map(step => <QuintarStepTile catalog={referenceCatalog} complete={isComplete(step.id)} key={step.id} missingParents={step.requires.filter(id => !isComplete(id)).map(id => QUINTAR_BREEDING_STEPS.find(entry => entry.id === id)!.title).join(', ')} next={step.id === nextStep?.id} number={QUINTAR_BREEDING_STEPS.indexOf(step) + 1} onToggle={toggle} pending={queuedUpdates.has(step.id)} step={step}/>)}</div>
      </section>
    })}</div>
  </>
}
