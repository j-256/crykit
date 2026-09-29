import { useId, type ReactNode } from 'react'
import { entityDefinitionKey, requirePlaythrough } from '../domain/core'
import { snapshotSlots, type SnapshotSlot } from '../domain/character-snapshots'
import { equipmentFacts, equipmentRole, isWeapon } from '../domain/mechanics-facts'
import { passivePosition } from '../domain/passive-loadout'
import type { CatalogSnapshot, Character, EntityRef, Knowledge, LearnedNode, ObservedStat, LocalData } from '../domain/types'
import { MemberArtwork } from './MemberSheet'
import { Icon, type IconName } from './icons'
import { entityName, formatRelativeDate, knowledgeLabel, ownRecordValue, resolveEntity } from './model'
import { useNavigation, type CharactersPageRoute } from './navigation'
import { DefinitionModLabel } from './DefinitionModLabel'
import { fieldFocusQuery } from './field-focus'
import './character-overview.css'

const UNKNOWN: Knowledge<never> = { state: 'unknown' }
const VITAL_NAMES = ['HP', 'MP'] as const
const STAT_ICONS: Readonly<Record<string, IconName>> = Object.freeze({
  HP: 'shield',
  'Max HP': 'shield',
  'Max. HP': 'shield',
  MP: 'crystal',
  'Max MP': 'crystal',
  'Max. MP': 'crystal',
  Attack: 'sword',
  Defense: 'shield',
  Resistance: 'shield',
  Speed: 'spark',
  Luck: 'spark',
})

function vitalKind(label: string) {
  return VITAL_NAMES.find(name => label.trim().toUpperCase().replace(/^MAX\.?\s+/, '') === name)
}

function OverviewLink({ page, children, className = '', title, query = {}, ariaLabel }: { readonly page: CharactersPageRoute; readonly children: ReactNode; readonly className?: string; readonly title?: string; readonly query?: Readonly<Record<string, readonly string[]>>; readonly ariaLabel?: string }) {
  const navigation = useNavigation()
  const route = { page, overlays: [], query }
  return <a aria-label={ariaLabel} className={className} href={navigation.href(route)} onClick={event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    navigation.navigate(route)
  }} title={title}>{children}</a>
}

function RecordedNumber({ value, unit }: { readonly value: Knowledge<number>; readonly unit?: string }) {
  return <span data-state={value.state}>{knowledgeLabel(value)}{value.state === 'known' && unit && unit !== 'displayed' && <small> {unit}</small>}</span>
}

function RecordedVitals({ stats }: { readonly stats: readonly [string, ObservedStat][] }) {
  return VITAL_NAMES.flatMap(name => {
    const recorded = stats.filter(([label]) => vitalKind(label) === name)
    return recorded.length ? recorded.map(([label, stat]) => <StatValue key={label} label={label} stat={stat}/>) : [<StatValue key={name} label={name}/>]
  })
}

function StatValue({ label, stat }: { readonly label: string; readonly stat?: ObservedStat }) {
  const value = stat?.value ?? UNKNOWN
  const display = knowledgeLabel(value)
  const unit = value.state === 'known' && stat?.unit && stat.unit !== 'displayed' ? ` ${stat.unit}` : ''
  return <div className={`roster-stat roster-stat--${vitalKind(label)?.toLowerCase() ?? 'other'}`} title={`${label}: ${display}${unit}`}><dt><Icon name={STAT_ICONS[label] ?? 'spark'}/>{label}</dt><dd><RecordedNumber unit={stat?.unit} value={value}/></dd></div>
}

function learnedSummary(nodes: readonly LearnedNode[]): string {
  if (!nodes.length) return 'Unrecorded'
  const confirmed = nodes.filter(node => node.learned.state === 'known' && node.learned.value).length
  const notLearned = nodes.filter(node => node.learned.state === 'known' && !node.learned.value).length
  const unknown = nodes.filter(node => node.learned.state === 'unknown').length
  const conflicting = nodes.filter(node => node.learned.state === 'conflicting').length
  const notApplicable = nodes.filter(node => node.learned.state === 'notApplicable').length
  return [`${confirmed} confirmed`, notLearned && `${notLearned} not learned`, unknown && `${unknown} unknown`, conflicting && `${conflicting} conflicting`, notApplicable && `${notApplicable} not applicable`].filter(Boolean).join(' · ')
}

function recordedSlotIcon(role: ReturnType<typeof equipmentRole>): IconName {
  if (role === 'mainHand') return 'sword'
  if (role === 'offHand') return 'shield'
  if (role === 'head') return 'character'
  if (role === 'body') return 'chest'
  if (role === 'accessory') return 'ring'
  return 'box'
}

function RecordedSlots({ slots, localData, catalogs, gameSetup, showNames = false, slotPage }: { readonly slots: readonly SnapshotSlot[]; readonly localData: LocalData; readonly catalogs: readonly CatalogSnapshot[]; readonly gameSetup?: LocalData['gameSetups'][string]; readonly showNames?: boolean; readonly slotPage?: CharactersPageRoute }) {
  const configuredSlot = (slot: SnapshotSlot) => gameSetup?.slots.find(candidate => candidate.id === slot.id)
  const slotRole = (slot: SnapshotSlot) => {
    const configured = configuredSlot(slot)
    return configured ? equipmentRole(configured) : undefined
  }
  const mainHandSlot = slots.find(slot => slotRole(slot) === 'mainHand')
  const mainHandDefinition = mainHandSlot?.selection ? resolveEntity(localData, catalogs, mainHandSlot.selection) : undefined
  const twoHandedMain = mainHandDefinition && mainHandSlot?.selection && equipmentFacts(mainHandDefinition).twoHanded === true ? { name: mainHandDefinition.name, value: mainHandSlot.selection } : undefined
  return <dl className="roster-slots">{slots.map(slot => {
    const name = slot.selection === undefined ? 'Unknown' : slot.selection === null ? 'Empty' : entityName(localData, catalogs, slot.selection)
    const role = slotRole(slot)
    const definition = slot.selection ? resolveEntity(localData, catalogs, slot.selection) : undefined
    const facts = definition && (role === 'mainHand' || role === 'offHand') ? equipmentFacts(definition) : undefined
    const handUse = facts?.type && isWeapon(facts.type) ? facts.twoHanded === false ? 'One-handed' : facts.twoHanded === true ? 'Two-handed' : 'Hand use unknown' : undefined
    const occupiedBy = role === 'offHand' ? twoHandedMain : undefined
    const displayName = occupiedBy && !slot.selection ? `Occupied by ${occupiedBy.name}` : name
    const title = [`${slot.label}: ${displayName}`, ...(handUse ? [handUse] : []), ...(occupiedBy ? [`Unavailable while ${occupiedBy.name} occupies both hands`] : [])].join('\n')
    const content = <><span aria-hidden="true" className="roster-slot__art">{slot.selection ? <MemberArtwork catalogs={catalogs} localData={localData} value={slot.selection}/> : occupiedBy ? <MemberArtwork catalogs={catalogs} localData={localData} value={occupiedBy.value}/> : <Icon data-empty-slot-icon={recordedSlotIcon(role)} name={recordedSlotIcon(role)}/>}</span><span className={`${showNames ? '' : 'sr-only '}roster-slot__identity`}><span>{displayName}</span><span className="sr-only"><DefinitionModLabel localData={localData} gameSetup={gameSetup} value={slot.selection}/></span></span></>
    return <div data-occupied-by-two-handed={occupiedBy?.name || undefined} data-state={occupiedBy && !slot.selection ? 'occupied' : slot.selection === undefined ? 'unknown' : slot.selection === null ? 'empty' : 'known'} key={slot.id} title={title}>
      <dt className="sr-only">{slot.label}</dt>
      <dd>{slotPage ? <OverviewLink ariaLabel={`Open ${slot.label}: ${displayName}`} className="roster-slot__link" page={slotPage} query={fieldFocusQuery(`slot:${slot.id}`)}>{content}</OverviewLink> : content}</dd>
    </div>
  })}</dl>
}

function CharacterCard({ character, localData, catalogs }: { readonly character: Character; readonly localData: LocalData; readonly catalogs: readonly CatalogSnapshot[] }) {
  const headingId = useId()
  const snapshot = character.currentSnapshotId ? ownRecordValue(character.snapshots, character.currentSnapshotId) : undefined
  const primary = snapshot?.primaryClass.state === 'known' ? snapshot.primaryClass.value : undefined
  const progress = primary ? Object.values(character.classProgress).find(row => entityDefinitionKey(row.classRef) === entityDefinitionKey(primary)) : undefined
  const gameSetup = snapshot?.gameSetupRevisionId ? ownRecordValue(localData.gameSetups, snapshot.gameSetupRevisionId) : undefined
  const slots = snapshot ? snapshotSlots(localData, snapshot) : []
  const passiveSlots: readonly SnapshotSlot[] = snapshot?.passives.state === 'known' ? snapshot.passives.value.map((selection, index) => ({ ...passivePosition(index), selection })) : []
  const stats = Object.entries(snapshot?.displayedStats ?? {})
  const otherStats = stats.filter(([label]) => !vitalKind(label))
  const className = (value: Knowledge<EntityRef> | undefined) => knowledgeLabel(value ?? UNKNOWN, ref => entityName(localData, catalogs, ref))
  const classRef = (value: Knowledge<EntityRef> | undefined) => value?.state === 'known' ? value.value : undefined
  const memberPage = { page: 'characters', view: 'character', characterId: character.id, tab: 'current' } as const

  return <article aria-labelledby={headingId} className="roster-card">
    <header className="roster-card__header">
      <div className="roster-card__identity"><span aria-hidden="true" className="member-portrait"><Icon name="character"/><MemberArtwork catalogs={catalogs} localData={localData} value={primary}/></span><div><h2 id={headingId}><OverviewLink page={memberPage}>{character.name}</OverviewLink></h2>{character.appearanceLabel && <p>{character.appearanceLabel}</p>}</div></div>
      <dl className="roster-level"><div><dt>Lv</dt><dd><RecordedNumber value={snapshot?.level ?? UNKNOWN}/></dd></div></dl>
    </header>
    {snapshot ? <>
      <div className="roster-card__body">
        <dl className="roster-classes"><div><dt>Primary class</dt><dd>{className(snapshot.primaryClass)}<DefinitionModLabel localData={localData} gameSetup={gameSetup} value={classRef(snapshot.primaryClass)}/></dd></div><div><dt>Secondary class</dt><dd>{className(snapshot.secondaryClass)}<DefinitionModLabel localData={localData} gameSetup={gameSetup} value={classRef(snapshot.secondaryClass)}/></dd></div></dl>
        <section aria-label={`${character.name}: recorded stats`} className="roster-stats"><h3>Recorded stats</h3><dl>
          <RecordedVitals stats={stats}/>
          {otherStats.map(([label, stat]) => <StatValue key={label} label={label} stat={stat}/>)}
        </dl></section>
        <section aria-label={`${character.name}: recorded equipment`} className="roster-equipment"><h3>{slots.some(slot => slot.kind === 'unmapped') ? 'Equipment & other slots' : 'Equipment'}</h3>{slots.length ? <RecordedSlots catalogs={catalogs} localData={localData} gameSetup={gameSetup} slotPage={memberPage} slots={slots}/> : <p className="roster-empty">No equipment recorded</p>}{!gameSetup && <p className="roster-empty">Slot context unrecorded</p>}</section>
        <section aria-label={`${character.name}: recorded passives`} className="roster-passives"><h3>Equipped passives</h3>{snapshot.passives.state === 'known' ? passiveSlots.length > 0 ? <RecordedSlots catalogs={catalogs} localData={localData} gameSetup={gameSetup} showNames slots={passiveSlots}/> : <p className="roster-empty"><Icon name="spark"/>None equipped</p> : <p className="roster-empty"><Icon name="warning"/>{knowledgeLabel(snapshot.passives)}</p>}</section>
        <section aria-label={`${character.name}: character learning`} className="roster-learning"><h3>Learning records</h3><dl>
          <div><dt>Primary class LP</dt><dd><RecordedNumber value={progress?.observedLp ?? UNKNOWN}/></dd></div>
          <div><dt>Primary class mastered</dt><dd data-state={progress?.mastered.state ?? 'unknown'}>{knowledgeLabel(progress?.mastered ?? UNKNOWN, mastered => mastered ? 'Yes' : 'No')}</dd></div>
          <div><dt>Learned skills</dt><dd title={learnedSummary(Object.values(character.learnedNodes))}>{learnedSummary(Object.values(character.learnedNodes))}</dd></div>
        </dl></section>
      </div>
    </> : <div className="roster-card__blank"><Icon name="character"/><div><strong>{character.currentSnapshotId ? 'Current snapshot unavailable' : 'No snapshot recorded'}</strong><p>{character.currentSnapshotId ? 'The referenced snapshot is missing. Earlier snapshots remain in History.' : 'Capture a character sheet to add stats, equipment, and passives.'}</p>{Object.keys(character.learnedNodes).length > 0 && <p>Learned skills: {learnedSummary(Object.values(character.learnedNodes))}</p>}</div><OverviewLink className="button button--secondary" page={{ page: 'characters', view: 'snapshot-new', characterId: character.id }}>Capture snapshot</OverviewLink></div>}
    <footer className="roster-card__footer"><div className="roster-observation">{snapshot ? <span title={`Recorded ${formatRelativeDate(snapshot.recordedAt)}`}>{snapshot.observedAt ? `Observed ${formatRelativeDate(snapshot.observedAt)}` : 'Observation date unknown'}</span> : <span>Stats and equipment unknown</span>}</div><nav aria-label={`${character.name} shortcuts`}><OverviewLink page={memberPage} title="Skills"><Icon name="spark"/><span className="sr-only">Skills</span></OverviewLink><OverviewLink page={{ ...memberPage, tab: 'history' }} title="History"><Icon name="history"/><span className="sr-only">History</span></OverviewLink></nav></footer>
  </article>
}

export function CharacterOverview({ localData, catalogs }: { readonly localData: LocalData; readonly catalogs: readonly CatalogSnapshot[] }) {
  return <section aria-label="Character overview" className="character-overview">{Object.values(requirePlaythrough(localData).characters).map(character => <CharacterCard catalogs={catalogs} character={character} key={character.id} localData={localData}/>)}</section>
}
