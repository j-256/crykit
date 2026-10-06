import { memo, useCallback, useState } from 'react'
import { LEGACY_CATALOG_REVISION_ID } from '../catalog/legacy-version'
import { QUINTAR_BREEDING_STEPS, QUINTAR_GUIDE_SOURCE, QUINTAR_NURSERY_CAPACITY, QUINTAR_PHASES, QUINTAR_STEP, quintarParentsAfterStep, quintarRaceRequirements, type QuintarBreedingStep, type QuintarBreedingStepId } from '../catalog/quintar-breeding'
import { QUINTAR_NATIVE_EVIDENCE } from '../catalog/quintar-native-rules'
import { QUINTAR_STEP_REFERENCES, quintarOcarinaPrice } from '../catalog/quintar-references'
import { quintarGuideArtwork, type QuintarGuideArtworkKey } from '../catalog/sprites'
import { STARTER_CATALOG_ID } from '../catalog/catalog-ids'
import { requirePlaythrough } from '../domain/core'
import type { CatalogSnapshot, EntityId, LocalData } from '../domain/types'
import { Button, InlineNotice } from './components'
import { Icon, type IconName } from './icons'
import { Money, MoneyText } from './MoneyText'
import { ProgressPage } from './ProgressPage'
import { ReferenceLink } from './ReferenceLink'
import { Sources } from './Sources'
import { useQueuedTileUpdates } from './useQueuedTileUpdates'
import './quintar-breeding.css'

const GUIDE_FOOD_ITEM_IDS = new Set([203, 204, 205])
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

function QuintarStepArtwork({ step, loading = 'eager' }: {
  readonly step?: QuintarBreedingStep
  readonly loading?: 'eager' | 'lazy'
}) {
  const [artworkFailed, setArtworkFailed] = useState(false)
  const artworkKey = step ? STEP_ARTWORK[step.id] ?? (step.parents ? 'egg' : undefined) : 'golden'
  const artwork = artworkKey && quintarGuideArtwork(artworkKey)
  return artwork && !artworkFailed ? <img alt="" decoding="async" height={artwork.asset.height} loading={loading} onError={() => setArtworkFailed(true)} src={artwork.url} width={artwork.asset.width}/> : <Icon name={step ? PHASE_ICONS[step.phase] : 'check'}/>
}

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
  const ocarinaPrice = step.id === QUINTAR_STEP.ocarina ? quintarOcarinaPrice(catalog) : undefined
  const parents = quintarParentsAfterStep(step)
  const references = QUINTAR_STEP_REFERENCES[step.id].filter(target => catalog?.entities[target.entityId]?.kind === target.kind)
  return <article aria-busy={pending || undefined} className="quintar-tile" data-complete={complete} data-next={next || undefined} data-step={step.id} data-type={step.result?.type}>
    <button aria-label={`Step ${number}: ${step.title}. ${complete ? 'Mark incomplete' : 'Mark complete'}`} aria-pressed={complete} className="quintar-tile__toggle" id={`quintar-step-${step.id}`} onClick={() => onToggle(step.id, complete)} type="button">
      <span className="quintar-tile__top"><span className="quintar-tile__number">{String(number).padStart(2, '0')}</span><span className="quintar-tile__status">{complete ? 'Complete' : next ? 'Next step' : 'Not marked'}</span><span aria-hidden="true" className="quintar-tile__check">{complete ? <Icon name="check"/> : <span/>}</span></span>
      <span aria-hidden="true" className="quintar-tile__art"><QuintarStepArtwork loading="lazy" step={step}/>{step.result && <span>{step.result.type}</span>}</span>
      <strong>{step.title}</strong>
      <small>{complete ? 'Click to undo' : 'Click when done'}</small>
    </button>
    <div className="quintar-tile__guide">
      {step.parents && <p className="quintar-tile__pair"><strong>{step.parents[0].name}</strong><span role="img" aria-label="paired with">+</span><strong>{step.parents[1].name}</strong></p>}
      <p><MoneyText>{step.instruction}</MoneyText>{ocarinaPrice !== undefined && <> Shop price: <Money copper={ocarinaPrice}/>.</>}</p>
      {races.length > 0 && <div className="quintar-tile__races"><span>First-place wins before breeding</span>{races.map(parent => <p key={parent.name}><strong>{parent.name}</strong><span>{parent.wins === 0 ? 'No wins required' : `${parent.wins} different ${parent.wins === 1 ? 'track' : 'tracks'} total`}</span></p>)}</div>}
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
  const referenceCatalog = catalogs.find(catalog => catalog.id === STARTER_CATALOG_ID && catalog.revisionId === LEGACY_CATALOG_REVISION_ID)
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
  return <ProgressPage count={completeCount} notices={failure && <InlineNotice title="Step not saved" tone="danger">{failure.message} After queued clicks finish, the tile shows its saved state. <Button disabled={queuedUpdates.has(failure.stepId)} onClick={() => toggle(failure.stepId, isComplete(failure.stepId))} tone="secondary">Retry step</Button></InlineNotice>} summaryIcon={<QuintarStepArtwork key={nextStep?.id} step={nextStep}/>} summaryDetails={<div className="quintar-summary__next"><div className="quintar-summary__copy"><span>{nextStep ? 'Next unmarked step' : 'Guide complete'}</span><strong>{nextStep?.title ?? 'Your Golden Quintar route is complete!'}</strong></div><p>{nextStep ? 'You can mark steps in any order. Only the tile you click changes.' : 'Click any completed tile to undo its mark.'}</p>{nextStep && <Button onClick={focusNextStep} tone="secondary">Go to next step</Button>}</div>} total={QUINTAR_BREEDING_STEPS.length} variant="quintar">
    <details className="quintar-tips">
      <summary>Breeding tips</summary>
      <div>
        <p><strong>Before every pairing:</strong> both parents must show Happy!, have different natures, and meet the listed race minimums. The nursery needs an empty slot; it holds {QUINTAR_NURSERY_CAPACITY} quintars. Each hatch consumes {QUINTAR_NATIVE_EVIDENCE.incubatorsPerHatch} Incubator. Hatch the egg before marking its step complete.</p>
        <p><strong>Race wins are cumulative:</strong> the listed minimum counts first place for that individual quintar on different tracks. Repeating the same track does not add another distinct win. Each parent's requirement depends on its partner's type.</p>
        <p><strong>Food and readiness:</strong> For this route, Happy! means the quintar meets its happiness, fullness, and rest checks. It does not mean happiness alone is full. Feed berries for happiness before cheese: cheese fills the quintar, preventing more food until fullness falls.</p>
        <ul>{QUINTAR_NATIVE_EVIDENCE.food.filter(food => GUIDE_FOOD_ITEM_IDS.has(food.itemID)).map(food => <li key={food.itemID}><strong>{food.name}:</strong> feed below {food.fullnessBelow} fullness. {food.happinessGain > 0 ? <>Adds {food.happinessGain} happiness (up to {food.happinessMaximum}) and {food.fullnessGain} fullness (up to {food.fullnessMaximum}).</> : <>Fills fullness to {food.fullnessMaximum} and reduces tiredness by up to {food.tirednessReduction}, stopping at {food.tirednessMinimum}; a lower tiredness value stays unchanged.</>}</li>)}</ul>
        <p>A Cookie can fill happiness while the quintar still needs food or rest to reach the Happy! status.</p>
        <Sources anchor={<p><strong>Release advice follows this route:</strong> hatch the child first, keep every parent needed by a later pairing, and keep any quintar you want for another purpose. Marks record completed actions, not your current nursery roster or inventory.</p>} label="Sources for Quintar breeding"><p>Route sequence and capture landmarks: <a href={QUINTAR_GUIDE_SOURCE} rel="noreferrer" target="_blank">the wiki's Method 2</a>. Pairings match the native outcomes; release advice follows this route.</p></Sources>
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
  </ProgressPage>
}
