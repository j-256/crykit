import { useState } from 'react'
import { sameBuildBehavior } from '../domain/build-behavior'
import { SUGGESTED_BUILD_SLOTS } from '../domain/build-planning'
import { resolveGameRules } from '../domain/game-rules'
import { equipmentFacts, equipmentRole } from '../domain/mechanics-facts'
import { TEAM_SIZE } from '../domain/scenarios'
import type { BuildRevisionId, CatalogSnapshot, LocalData } from '../domain/types'
import { BuildLoadoutSummary } from './BuildLoadoutSummary'
import { CalculationInputs } from './CalculationInputs'
import { Badge } from './components'
import { subCommandLabel } from './definition-fields'
import { DefinitionArtwork } from './GameIcon'
import { Icon, type IconName } from './icons'
import { entityName, resolveEntity } from './model'
import { newerTeamCheckpoint, reviewTeam } from './TeamReview'

interface Props {
  readonly slots: readonly (BuildRevisionId | null)[]
  readonly localData: LocalData
  readonly catalogs: readonly CatalogSnapshot[]
  readonly compact?: boolean
}

interface MemberProps extends Omit<Props, 'slots'> {
  readonly id: BuildRevisionId | null
  readonly index: number
  readonly showSetup: boolean
  readonly layout: TeamLayout
  readonly check?: ReturnType<typeof reviewTeam>['members'][number]
}

type TeamLayout = 'row' | 'grid' | 'page'
const TEAM_LAYOUT_OPTIONS: readonly { readonly value: TeamLayout; readonly label: string; readonly icon: IconName }[] = [
  { value: 'row', label: '4 across', icon: 'layout-row' },
  { value: 'grid', label: '2 by 2', icon: 'layout-grid' },
  { value: 'page', label: '1 at a time', icon: 'layout-page' },
]
const NARROW_TEAM_LAYOUT_QUERY = '(max-width: 700px)'

function initialTeamLayout(): TeamLayout {
  return typeof window !== 'undefined' && window.matchMedia?.(NARROW_TEAM_LAYOUT_QUERY).matches ? 'page' : 'grid'
}

export function teamSetupStatus(slots: readonly (BuildRevisionId | null)[], localData: LocalData): 'none' | 'one' | 'compatible' | 'different' | 'missing' | 'unavailable' {
  if (slots.some(id => id && !localData.buildRevisions[id])) return 'missing'
  const revisions = slots.flatMap(id => id && localData.buildRevisions[id] ? [localData.buildRevisions[id]] : [])
  if (!revisions.length) return 'none'
  const setups = revisions.map(revision => localData.gameSetups[revision.gameSetupRevisionId])
  if (setups.some(setup => !setup)) return 'unavailable'
  if (setups.length === 1) return 'one'
  return setups.every(setup => sameBuildBehavior(setups[0], setup)) ? 'compatible' : 'different'
}

function TeamMemberCard({ id, index, localData, catalogs, compact = false, showSetup, layout, check }: MemberProps) {
  const revision = id ? localData.buildRevisions[id] : undefined
  const build = revision ? localData.builds[revision.buildId] : undefined
  const setup = revision ? localData.gameSetups[revision.gameSetupRevisionId] : undefined
  const slotsForBuild = setup?.slots.length ? setup.slots : SUGGESTED_BUILD_SLOTS
  const mainHandSlot = slotsForBuild.find(slot => equipmentRole(slot) === 'mainHand')
  const offHandSlot = slotsForBuild.find(slot => equipmentRole(slot) === 'offHand')
  const mainHand = mainHandSlot ? revision?.content.equipment[mainHandSlot.id] : undefined
  const offHand = offHandSlot ? revision?.content.equipment[offHandSlot.id] : undefined
  const mainHandDefinition = mainHand ? resolveEntity(localData, catalogs, mainHand.ref) : undefined
  // A two-handed item can occupy the off hand through a shared allocation or an empty slot
  const offHandOccupied = mainHandDefinition && equipmentFacts(mainHandDefinition).twoHanded === true && (!offHand || Boolean(offHand.allocationId && offHand.allocationId === mainHand?.allocationId))
  const primaryClass = revision?.content.primaryClass
  const secondaryClass = revision?.content.secondaryClass
  const command = secondaryClass ? resolveEntity(localData, catalogs, secondaryClass) : undefined
  const commandName = command ? subCommandLabel({ record: command, name: command.name }) : secondaryClass ? entityName(localData, catalogs, secondaryClass) : undefined
  const newer = revision ? newerTeamCheckpoint(localData, revision) : undefined
  const MemberHeading = compact ? 'h3' : 'h2'
  return <li className="team-overview__member">
    <section aria-label={`Team slot ${index + 1} overview`}>
      <div className="team-overview__hero">
        <span aria-hidden="true" className="team-overview__portrait">{primaryClass ? <DefinitionArtwork catalogs={catalogs} compact={false} localData={localData} value={primaryClass}/> : <Icon name="character"/>}</span>
        <div className="team-overview__identity">
          <MemberHeading>{build?.title ?? (id ? 'Checkpoint unavailable' : 'Unassigned member')}</MemberHeading>
          {revision ? <p><strong>{primaryClass ? entityName(localData, catalogs, primaryClass) : 'Class not selected'}</strong>{commandName && <span> · {commandName}</span>}</p> : <p>{id ? 'Review this slot in Edit Team' : 'Choose a checkpoint in Edit Team'}</p>}
        </div>
        <span aria-label={`Slot ${index + 1}`} className="team-overview__slot">{String(index + 1).padStart(2, '0')}</span>
      </div>
      {revision && <>
        <div className="team-overview__metadata">
          <span>Checkpoint r{revision.revision}</span>
          {revision.note && <span>{revision.note}</span>}
          {compact && revision.content.passives.length > 0 && <span>{revision.content.passives.length} {revision.content.passives.length === 1 ? 'passive' : 'passives'}</span>}
          {showSetup && <span>{setup?.label ?? 'Game Setup unavailable'}</span>}
          {check?.report.status === 'invalid' && <Badge tone="danger">Needs changes</Badge>}
          {check?.report.status === 'undetermined' && <Badge tone="warning">Unresolved checks</Badge>}
          {newer && <Badge tone="info">r{newer.revision} available</Badge>}
        </div>
        {compact ? <div className="team-overview__quickgear"><span aria-hidden="true" className="team-overview__weapon-art">{mainHand && <DefinitionArtwork catalogs={catalogs} localData={localData} value={mainHand.ref}/>}</span><span><small>Main hand</small><strong>{mainHand ? entityName(localData, catalogs, mainHand.ref) : 'No selection'}</strong>{offHandOccupied ? <small>Off hand: Occupied by {mainHandDefinition.name}</small> : offHand && <small>Off hand: {entityName(localData, catalogs, offHand.ref)}</small>}</span></div> : <div className="team-overview__loadout">
          <BuildLoadoutSummary catalogs={catalogs} content={revision.content} equipmentNames={layout !== 'row'} gameSetup={setup} localData={localData} showClasses={false}/>
          {(revision.content.rotationNotes || revision.content.contextAssumptions.length > 0) && <details className="team-overview__notes"><summary>Build notes and assumptions</summary>{revision.content.rotationNotes && <p>{revision.content.rotationNotes}</p>}{revision.content.contextAssumptions.map((note, noteIndex) => <p key={noteIndex}>{note}</p>)}</details>}
          {revision.content.calculation && <details className="team-overview__notes"><summary>Calculation inputs</summary><CalculationInputs catalogs={catalogs} genders={setup ? resolveGameRules(setup, catalogs).genders : undefined} localData={localData} plan={revision.content.calculation}/></details>}
        </div>}
      </>}
    </section>
  </li>
}

export function TeamOverview({ slots, localData, catalogs, compact = false }: Props) {
  const [layout, setLayout] = useState<TeamLayout>(initialTeamLayout)
  const [pageIndex, setPageIndex] = useState(0)
  const review = reviewTeam(slots, localData, catalogs)
  const setupStatus = teamSetupStatus(slots, localData)
  const setupIds = slots.flatMap(id => id && localData.buildRevisions[id] ? [localData.buildRevisions[id].gameSetupRevisionId] : [])
  const showSetup = new Set(setupIds).size > 1 || setupStatus === 'unavailable'
  const setupLabel = {
    none: 'No Game Setup selected',
    one: setupIds[0] ? localData.gameSetups[setupIds[0]]?.label ?? 'Game Setup unavailable' : 'No Game Setup selected',
    compatible: showSetup ? 'Selected Game Setups match' : localData.gameSetups[setupIds[0]]?.label ?? 'Game Setup unavailable',
    different: 'Selected Game Setups differ',
    missing: 'A checkpoint is unavailable',
    unavailable: 'A Game Setup is unavailable',
  }[setupStatus]
  const page = Math.min(pageIndex, slots.length - 1)
  const pager = (position: 'top' | 'bottom') => <nav aria-label={`${position === 'top' ? 'Top' : 'Bottom'} Team member pages`} className="team-overview__pager">
    <button disabled={page === 0} onClick={() => setPageIndex(page - 1)} title="Previous member" type="button"><Icon name="arrow-left"/><span className="sr-only">Previous member</span></button>
    <div className="team-overview__page-links">{slots.map((id, index) => {
      const revision = id ? localData.buildRevisions[id] : undefined
      const label = revision ? localData.builds[revision.buildId]?.title ?? 'Build' : 'Empty'
      return <button aria-current={page === index ? 'page' : undefined} key={index} onClick={() => setPageIndex(index)} type="button">{index + 1}. {label}</button>
    })}</div>
    <button disabled={page === slots.length - 1} onClick={() => setPageIndex(page + 1)} title="Next member" type="button"><Icon name="arrow-right"/><span className="sr-only">Next member</span></button>
  </nav>
  return <div className={`team-overview${compact ? ' team-overview--compact' : ''}`} data-layout={compact ? undefined : layout}>
    <div aria-label="Team overview" className="team-overview__status">
      <strong>{review.filled}/{TEAM_SIZE} members</strong>
      {setupStatus === 'different' || setupStatus === 'missing' || setupStatus === 'unavailable' ? <Badge tone="warning">{setupLabel}</Badge> : <span>{setupLabel}</span>}
      {review.filled > 0 && review.valid === review.filled && <span>No known build issues</span>}
      {review.invalid > 0 && <Badge tone="danger">{review.invalid} need changes</Badge>}
      {review.unresolved > 0 && <Badge tone="warning">{review.unresolved} unresolved</Badge>}
      {review.newer > 0 && <Badge tone="info">{review.newer} newer {review.newer === 1 ? 'checkpoint' : 'checkpoints'}</Badge>}
    </div>
    {!compact && <div aria-label="Team layout" className="segmented team-overview__layout" role="group">{TEAM_LAYOUT_OPTIONS.map(option => <button aria-pressed={layout === option.value} key={option.value} onClick={() => setLayout(option.value)} title={option.label} type="button"><Icon name={option.icon}/><span className="sr-only">{option.label}</span></button>)}</div>}
    {!compact && layout === 'page' && pager('top')}
    <div className="team-overview__viewport"><ol className="team-overview__members">{slots.map((id, index) => compact || layout !== 'page' || index === page ? <TeamMemberCard catalogs={catalogs} check={review.members.find(member => member.index === index)} compact={compact} id={id} index={index} key={index} layout={layout} localData={localData} showSetup={showSetup}/> : null)}</ol></div>
    {!compact && layout === 'page' && pager('bottom')}
  </div>
}
