import type { ReactNode } from 'react'
import { definitionModAvailability, type DefinitionModAvailability } from '../catalog/mods'
import { snapshotSlots, type SnapshotValue } from '../domain/character-snapshots'
import type { CatalogSnapshot, CharacterSnapshot, EntityRef, Knowledge, LocalData, GameSetupRevision, SourceRef } from '../domain/types'
import { IconButton, InlineNotice } from './components'
import { entityName, formatRelativeDate, ownRecordValue } from './model'
import { useNavigation, type AppRoute } from './navigation'
import { ModBadge } from './DefinitionModLabel'

const GAME_SETUP_SETTINGS_ROUTE: AppRoute = { page: { page: 'settings', section: 'game-setup' }, overlays: [], query: {} }
const RECORDED_MOD_EXPLANATIONS: Readonly<Record<DefinitionModAvailability['state'], string>> = {
  unknown: 'This snapshot does not record whether that mod was enabled in your game.',
  conflicting: 'This snapshot contains conflicting records about whether that mod was enabled in your game.',
  enabled: 'This snapshot records that mod as enabled in your game.',
  disabled: 'This snapshot records that mod as disabled in your game. Your recorded selection is still kept.',
}

interface RecordedContext {
  readonly localData: LocalData
  readonly catalogs: readonly CatalogSnapshot[]
  readonly gameSetup?: GameSetupRevision
}

function sourceLabel(source: SourceRef): string {
  return [source.sourceId, source.locator, source.snapshot, source.applicability, source.checkedAt].filter(Boolean).join(' · ')
}

export function RecordedModStatus({ availability, className = '' }: { readonly availability: DefinitionModAvailability; readonly className?: string }) {
  const navigation = useNavigation()
  if (!availability.requiredMod) return null
  return <details className={`recorded-sources recorded-mod ${className}`}>
    <summary><ModBadge name={availability.requiredMod} state={availability.state}/></summary>
    <p>This entry comes from the {availability.requiredMod} mod. {RECORDED_MOD_EXPLANATIONS[availability.state]} This label does not check whether a selection fits its slot.</p>
    <p>Update the mod setting in <a href={navigation.href(GAME_SETUP_SETTINGS_ROUTE)} onClick={(event) => { if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); navigation.navigate(GAME_SETUP_SETTINGS_ROUTE) } }}>Data &amp; settings &gt; Game Setup</a>, then capture a new character snapshot. Existing snapshots keep their recorded mod settings.</p>
  </details>
}

function DefinitionLink({ localData, catalogs, gameSetup, value, showIdentity }: RecordedContext & { readonly value: EntityRef; readonly showIdentity?: boolean }) {
  const navigation = useNavigation()
  const route = { page: { page: 'reference', view: 'detail', ref: value } as const, overlays: [], query: {} }
  const availability = definitionModAvailability(localData, value, gameSetup)
  return <div className="recorded-definition"><a href={navigation.href(route)} onClick={(event) => { if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); navigation.navigate(route) } }}>{entityName(localData, catalogs, value)}</a><RecordedModStatus availability={availability}/>{showIdentity && <details className="recorded-sources"><summary>Definition identity</summary><small>{value.kind === 'personal' ? `Personal definition: ${value.definitionId}` : `Catalog: ${value.catalogId} · revision: ${value.catalogRevisionId} · entry: ${value.entityId}`}</small></details>}</div>
}

function RecordedKnowledge<T>({ value, format }: { readonly value: Knowledge<T>; readonly format: (value: T) => ReactNode }) {
  if (value.state === 'conflicting') return <div>Conflicting claims<ul className="recorded-claims">{value.claims.map((claim, index) => <li key={index}>{format(claim.value)}{claim.note && <small>{claim.note}</small>}{claim.sources.length > 0 && <small>{claim.sources.map(sourceLabel).join('; ')}</small>}</li>)}</ul></div>
  return <div>{value.state === 'known' ? format(value.value) : value.state === 'notApplicable' ? 'Not applicable' : 'Unknown'}{'reason' in value && value.reason && <small>{value.reason}</small>}{'sources' in value && Boolean(value.sources?.length) && <details className="recorded-sources"><summary>Observation sources</summary>{value.sources?.map((source, index) => <small key={index}>{sourceLabel(source)}</small>)}</details>}</div>
}

export function SnapshotValueView({ localData, catalogs, gameSetup: recordedGameSetup, value, showIdentity }: RecordedContext & { readonly value: SnapshotValue; readonly showIdentity?: boolean }) {
  const definition = (ref: EntityRef) => <DefinitionLink catalogs={catalogs} localData={localData} gameSetup={recordedGameSetup} showIdentity={showIdentity} value={ref}/>
  if (value.kind === 'unrecorded') return <>Unrecorded</>
  if (value.kind === 'sources') return value.value.length ? <>{value.value.map((source, index) => <small key={index}>{sourceLabel(source)}</small>)}</> : <>Unrecorded</>
  if (value.kind === 'text') return <>{value.value === '' ? 'Empty text' : value.value ?? 'Unrecorded'}</>
  if (value.kind === 'selection') return value.value === undefined ? <>Unknown</> : value.value === null ? <>Empty</> : definition(value.value)
  if (value.kind === 'reference') return <RecordedKnowledge format={definition} value={value.value}/>
  if (value.kind === 'references') return <RecordedKnowledge format={(refs) => refs.length ? <>{refs.map((ref, index) => <div key={index}>{definition(ref)}</div>)}</> : <>None equipped</>} value={value.value}/>
  if (value.kind === 'number') return <RecordedKnowledge format={(number) => <>{number}{value.unit && value.unit !== 'displayed' ? ` ${value.unit}` : ''}</>} value={value.value}/>
  const gameSetup = value.value ? ownRecordValue(localData.gameSetups, value.value) : undefined
  return <>{gameSetup ? `${gameSetup.label} · revision ${gameSetup.revision}` : 'Unrecorded slot context'}</>
}

export function CharacterSheet({ localData, catalogs, snapshot, onEditSlot }: RecordedContext & { readonly snapshot: CharacterSnapshot; readonly onEditSlot?: (slotId: string) => void }) {
  const slots = snapshotSlots(localData, snapshot)
  const gameSetup = snapshot.gameSetupRevisionId ? ownRecordValue(localData.gameSetups, snapshot.gameSetupRevisionId) : undefined
  const summary: readonly { readonly label: string; readonly value: SnapshotValue }[] = [
    { label: 'Level', value: { kind: 'number', value: snapshot.level, unit: '' } },
    { label: 'Primary class', value: { kind: 'reference', value: snapshot.primaryClass } },
    { label: 'Secondary class', value: { kind: 'reference', value: snapshot.secondaryClass } },
  ]
  const context = { localData, catalogs, gameSetup }
  return <div className="recorded-sheet">
    <div className="recorded-sheet__observation"><span>{snapshot.observedAt ? `Observed ${formatRelativeDate(snapshot.observedAt)}` : 'Observation date unknown'}</span><small>Recorded {formatRelativeDate(snapshot.recordedAt)}</small>{snapshot.note && <p>{snapshot.note}</p>}</div>
    <dl className="recorded-summary">{summary.map(({ label, value }) => <div key={label}><dt>{label}</dt><dd><SnapshotValueView {...context} value={value}/></dd></div>)}</dl>
    <details className="recorded-sources"><summary>Recorded mods</summary><p>{gameSetup ? `${gameSetup.label} · revision ${gameSetup.revision}` : 'Game Setup context unrecorded'}</p><dl className="definition-list"><div className="definition-row"><dt>Enabled mods</dt><dd><RecordedKnowledge value={gameSetup?.mods ?? { state: 'unknown' }} format={names => names.join(', ') || 'None'}/></dd></div><div className="definition-row"><dt>Disabled mods</dt><dd><RecordedKnowledge value={gameSetup?.disabledMods ?? { state: 'unknown' }} format={names => names.join(', ') || 'None'}/></dd></div></dl></details>
    <div className="recorded-sheet__columns">
      <section aria-label="Displayed final stats"><h3>Displayed final stats</h3><p className="settings-section__intro">Saved in-game totals</p>{Object.keys(snapshot.displayedStats).length ? <dl className="recorded-stats">{Object.entries(snapshot.displayedStats).map(([key, stat]) => <div key={key}><dt>{key}</dt><dd><SnapshotValueView {...context} value={{ kind: 'number', ...stat }}/></dd></div>)}</dl> : <p className="recorded-empty">No displayed stats recorded. Unlisted values remain unrecorded.</p>}</section>
      <section aria-label="Equipment and equipped passives"><h3>Equipment & passives</h3><p className="settings-section__intro">{gameSetup ? `${gameSetup.label} · revision ${gameSetup.revision}` : 'Slot context was not recorded'}</p>
        {!gameSetup && <p className="recorded-context-warning">Stored slot IDs are shown without labels from another Game Setup.</p>}
        {slots.length ? <div className="recorded-slots">{slots.map((slot) => <div className="recorded-slot" key={slot.id}><div><span className="slot__label">{slot.label}{slot.kind === 'unmapped' && gameSetup && <small>Outside recorded slot context</small>}</span><div className="slot__value"><SnapshotValueView {...context} value={{ kind: 'selection', value: slot.selection }}/></div></div>{onEditSlot && gameSetup?.id === localData.planningGameSetupRevisionId && slot.kind !== 'unmapped' && <IconButton icon="edit" label={`Edit ${slot.label}`} onClick={() => onEditSlot(slot.id)}/>}</div>)}</div> : <p className="recorded-empty">No equipment selections recorded.</p>}
        <div className="recorded-slots">{snapshot.passives.state === 'known' ? snapshot.passives.value.length ? snapshot.passives.value.map((ref, index) => <div className="recorded-slot" key={`${entityName(localData, catalogs, ref)}:${index}`}><div><span className="slot__label">Equipped passive {index + 1}</span><div className="slot__value"><SnapshotValueView {...context} value={{ kind: 'selection', value: ref }}/></div></div></div>) : <p className="recorded-empty">No passives equipped.</p> : <p className="recorded-empty">Equipped passive list is {snapshot.passives.state === 'notApplicable' ? 'not applicable' : snapshot.passives.state}.</p>}</div>
      </section>
    </div>
    {onEditSlot && snapshot.gameSetupRevisionId !== localData.planningGameSetupRevisionId && <InlineNotice title="Slot context has changed">Capture a new snapshot to record selections under the current Game Setup. The earlier selections remain in this snapshot.</InlineNotice>}
  </div>
}
