import { useId, type ReactNode } from 'react'
import { entityDefinitionKey } from '../domain/core'
import { snapshotSlots, type SnapshotSlot } from '../domain/character-snapshots'
import type { CatalogSnapshot, Character, EntityRef, Knowledge, LearnedNode, ObservedStat, Profile } from '../domain/types'
import { MemberArtwork } from './MemberSheet'
import { Icon } from './icons'
import { entityName, formatRelativeDate, knowledgeLabel, ownRecordValue } from './model'
import { useNavigation, type CharactersPageRoute } from './navigation'
import './character-overview.css'

const UNKNOWN: Knowledge<never> = { state: 'unknown' }
const VITAL_NAMES = ['HP', 'MP'] as const

function vitalKind(label: string) {
  return VITAL_NAMES.find(name => label.trim().toUpperCase().replace(/^MAX\.?\s+/, '') === name)
}

function OverviewLink({ page, children, className = '' }: { readonly page: CharactersPageRoute; readonly children: ReactNode; readonly className?: string }) {
  const navigation = useNavigation()
  const route = { page, overlays: [], query: {} }
  return <a className={className} href={navigation.href(route)} onClick={event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    navigation.navigate(route)
  }}>{children}</a>
}

function RecordedNumber({ value, unit }: { readonly value: Knowledge<number>; readonly unit?: string }) {
  return <span data-state={value.state}>{knowledgeLabel(value)}{value.state === 'known' && unit && unit !== 'displayed' && <small> {unit}</small>}</span>
}

function RecordedVitals({ stats }: { readonly stats: readonly [string, ObservedStat][] }) {
  return VITAL_NAMES.flatMap(name => {
    const recorded = stats.filter(([label]) => vitalKind(label) === name)
    return recorded.length ? recorded.map(([label, stat]) => <div className={`roster-vital roster-vital--${name.toLowerCase()}`} key={label}><dt>{label}</dt><dd><RecordedNumber {...stat}/></dd></div>) : [<div className={`roster-vital roster-vital--${name.toLowerCase()}`} key={name}><dt>{name}</dt><dd data-state="unknown">Unknown</dd></div>]
  })
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

function RecordedSlots({ slots, profile, catalogs }: { readonly slots: readonly SnapshotSlot[]; readonly profile: Profile; readonly catalogs: readonly CatalogSnapshot[] }) {
  return <dl className="roster-slots">{slots.map(slot => <div key={slot.id}>
    <dt>{slot.label}</dt>
    <dd data-state={slot.selection === undefined ? 'unknown' : 'known'}><MemberArtwork catalogs={catalogs} profile={profile} value={slot.selection}/><span>{slot.selection === undefined ? 'Unknown' : slot.selection === null ? 'Empty' : entityName(profile, catalogs, slot.selection)}</span></dd>
  </div>)}</dl>
}

function CharacterCard({ character, profile, catalogs }: { readonly character: Character; readonly profile: Profile; readonly catalogs: readonly CatalogSnapshot[] }) {
  const headingId = useId()
  const snapshot = character.currentSnapshotId ? ownRecordValue(character.snapshots, character.currentSnapshotId) : undefined
  const primary = snapshot?.primaryClass.state === 'known' ? snapshot.primaryClass.value : undefined
  const progress = primary ? Object.values(character.classProgress).find(row => entityDefinitionKey(row.classRef) === entityDefinitionKey(primary)) : undefined
  const ruleset = snapshot?.rulesetRevisionId ? ownRecordValue(profile.rulesets, snapshot.rulesetRevisionId) : undefined
  const slots = snapshot ? snapshotSlots(profile, snapshot) : []
  const equipment = slots.filter(slot => slot.kind !== 'passive')
  const passives = slots.filter(slot => slot.kind === 'passive')
  const equippedPassives = passives.filter(slot => slot.selection != null)
  const otherPassives = passives.filter(slot => slot.selection == null)
  const emptyPassives = otherPassives.filter(slot => slot.selection === null).length
  const unknownPassives = otherPassives.length - emptyPassives
  const passiveSummary = [emptyPassives && `${emptyPassives} empty`, unknownPassives && `${unknownPassives} unknown`].filter(Boolean).join(' · ')
  const stats = Object.entries(snapshot?.displayedStats ?? {})
  const otherStats = stats.filter(([label]) => !vitalKind(label))
  const className = (value: Knowledge<EntityRef> | undefined) => knowledgeLabel(value ?? UNKNOWN, ref => entityName(profile, catalogs, ref))
  const memberPage = { page: 'characters', view: 'character', characterId: character.id, tab: 'current' } as const

  return <article aria-labelledby={headingId} className="roster-card">
    <header className="roster-card__header">
      <div className="roster-card__identity"><span aria-hidden="true" className="member-portrait"><Icon name="character"/><MemberArtwork catalogs={catalogs} profile={profile} value={primary}/></span><div><h2 id={headingId}><OverviewLink page={memberPage}>{character.name}</OverviewLink></h2>{character.appearanceLabel && <p>{character.appearanceLabel}</p>}</div></div>
      <dl className="roster-classes"><div><dt>Primary class</dt><dd>{className(snapshot?.primaryClass)}</dd></div><div><dt>Secondary class</dt><dd>{className(snapshot?.secondaryClass)}</dd></div></dl>
      <dl className="roster-level"><div><dt>Lv</dt><dd><RecordedNumber value={snapshot?.level ?? UNKNOWN}/></dd></div></dl>
    </header>
    {snapshot ? <>
      <div className="roster-card__body">
        <section aria-label={`${character.name}: recorded stats`} className="roster-stats"><h3>Recorded stats</h3><dl>
          <RecordedVitals stats={stats}/>
          {otherStats.map(([label, stat]) => <div key={label}><dt>{label}</dt><dd><RecordedNumber {...stat}/></dd></div>)}
          <div><dt>PP capacity</dt><dd><RecordedNumber value={snapshot.ppCapacity}/></dd></div>
        </dl></section>
        <section aria-label={`${character.name}: recorded equipment`} className="roster-equipment"><h3>{equipment.some(slot => slot.kind === 'unmapped') ? 'Equipment & other slots' : 'Equipment'}</h3>{equipment.length ? <RecordedSlots catalogs={catalogs} profile={profile} slots={equipment}/> : <p className="roster-empty">No equipment recorded</p>}{!ruleset && <p className="roster-empty">Slot context unrecorded</p>}</section>
        <section aria-label={`${character.name}: character learning`} className="roster-learning"><h3>Learning records</h3><dl>
          <div><dt>Primary class LP</dt><dd><RecordedNumber value={progress?.observedLp ?? UNKNOWN}/></dd></div>
          <div><dt>Primary class mastered</dt><dd data-state={progress?.mastered.state ?? 'unknown'}>{knowledgeLabel(progress?.mastered ?? UNKNOWN, mastered => mastered ? 'Yes' : 'No')}</dd></div>
          <div><dt>Learned skills</dt><dd>{learnedSummary(Object.values(character.learnedNodes))}</dd></div>
        </dl></section>
      </div>
      {passives.length > 0 && <section aria-label={`${character.name}: recorded passives`} className="roster-passives"><h3>Equipped passives</h3><div>{equippedPassives.length > 0 && <RecordedSlots catalogs={catalogs} profile={profile} slots={equippedPassives}/>}<details className="roster-passive-details" hidden={!otherPassives.length}><summary>{passiveSummary}</summary><RecordedSlots catalogs={catalogs} profile={profile} slots={otherPassives}/></details></div></section>}
    </> : <div className="roster-card__blank"><Icon name="character"/><div><strong>{character.currentSnapshotId ? 'Current snapshot unavailable' : 'No snapshot recorded'}</strong><p>{character.currentSnapshotId ? 'The referenced snapshot is missing. Earlier snapshots remain in History.' : 'Capture a character sheet to add stats, equipment, and passives.'}</p>{Object.keys(character.learnedNodes).length > 0 && <p>Learned skills: {learnedSummary(Object.values(character.learnedNodes))}</p>}</div><OverviewLink className="button button--secondary" page={{ page: 'characters', view: 'snapshot-new', characterId: character.id }}>Capture snapshot</OverviewLink></div>}
    <footer className="roster-card__footer"><div className="roster-observation">{snapshot ? <><span>{snapshot.observedAt ? `Observed ${formatRelativeDate(snapshot.observedAt)}` : 'Observation date unknown'}</span><small>Recorded {formatRelativeDate(snapshot.recordedAt)}</small></> : <span>Stats and equipment unknown</span>}</div><nav aria-label={`${character.name} views`}><OverviewLink className="roster-member-link" page={memberPage}>Member <Icon name="arrow-left"/></OverviewLink><OverviewLink page={{ ...memberPage, tab: 'knowledge' }}>Learn</OverviewLink><OverviewLink page={{ ...memberPage, tab: 'history' }}>History</OverviewLink></nav></footer>
  </article>
}

export function CharacterOverview({ profile, catalogs }: { readonly profile: Profile; readonly catalogs: readonly CatalogSnapshot[] }) {
  return <section aria-label="Character overview" className="character-overview">{Object.values(profile.characters).map(character => <CharacterCard catalogs={catalogs} character={character} key={character.id} profile={profile}/>)}</section>
}
