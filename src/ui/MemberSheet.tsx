import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { entityDefinitionKey } from '../domain'
import { snapshotSlots, type SnapshotSlot } from '../domain/character-snapshots'
import type { CatalogEntityKind, CatalogSnapshot, Character, CharacterSnapshot, EntityRef, Knowledge, Profile } from '../domain/types'
import { definitionModAvailability, modAvailabilityLabel } from '../catalog/mods'
import { Button, InlineNotice } from './components'
import { DefinitionDropdown, findDefinitionOption, useDefinitionWorkspace, type DefinitionOption } from './definitions'
import { commandName, matchesSlot } from './definition-fields'
import { Icon } from './icons'
import { KnowledgeValue, SourceReferences } from './KnowledgeValue'
import { entityName, formatAppError, formatRelativeDate, knowledgeLabel, ownRecordValue, resolveEntity } from './model'
import { routeWithOverlay, routeWithoutOverlays, useNavigation, useNavigationBlocker, type AppRoute } from './navigation'
import { WikiSprite, WikiSpriteSource } from './WikiSprite'
import { DefinitionArtwork, FieldIconSources } from './GameIcon'
import { RecordedModStatus, SnapshotValueView } from './CharacterSheet'
import type { SnapshotDraft } from './CharactersView'

const PRIMARY_CLASS = 'primary-class'
const SECONDARY_CLASS = 'secondary-class'
const PICKER_PAGE_SIZE = 100
const DESKTOP_MEMBER_QUERY = '(min-width: 1101px)'
const UNKNOWN: Knowledge<never> = { state: 'unknown' }
const CLASS_KINDS: readonly CatalogEntityKind[] = ['class']
const PASSIVE_KINDS: readonly CatalogEntityKind[] = ['passive', 'innate']
const ITEM_KINDS: readonly CatalogEntityKind[] = ['item']
const DETAIL_FIELDS = /^(command|weapons?|armors?|innate passives?(\(s\))?|attack|defen[cs]e|magic|resistance|speed|hands|other effects|effects?|pp cost)$/i

function knownRef(value: Knowledge<EntityRef>) { return value.state === 'known' ? value.value : undefined }

function currentMemberPicker(route: AppRoute) {
  return route.page.page === 'characters' && route.page.view === 'character' && route.page.tab === 'current' ? route.overlays.find(overlay => overlay.kind === 'definition-picker') : undefined
}

export function MemberArtwork({ profile, catalogs, value }: { profile: Profile; catalogs: readonly CatalogSnapshot[]; value?: EntityRef | null }) {
  const ref = value?.kind === 'personal' ? profile.personalDefinitions[value.definitionId]?.baseRef : value
  const entity = resolveEntity(profile, catalogs, ref)
  if (entity && ['ability', 'passive', 'monsterMagic', 'command'].includes(entity.kind)) return <DefinitionArtwork catalogs={catalogs} profile={profile} value={ref}/>
  return ref?.kind === 'catalog' && entity ? <WikiSprite catalogId={ref.catalogId} entity={{ id: ref.entityId, kind: entity.kind, name: entity.name }}/> : null
}

export function MemberSummary({ profile, catalogs, character, snapshot }: { profile: Profile; catalogs: readonly CatalogSnapshot[]; character: Character; snapshot?: CharacterSnapshot }) {
  const primary = snapshot && knownRef(snapshot.primaryClass)
  const historical = Boolean(snapshot && snapshot.id !== character.currentSnapshotId)
  const progress = primary && !historical ? Object.values(character.classProgress).find(row => entityDefinitionKey(row.classRef) === entityDefinitionKey(primary)) : undefined
  const vital = (name: string) => {
    const entries = Object.entries(snapshot?.displayedStats ?? {})
    const stat = entries.find(([key]) => key.toLowerCase() === name.toLowerCase()) ?? entries.find(([key]) => key.toLowerCase().replace('.', '') === `max ${name.toLowerCase()}`)
    return <div className={`member-vital member-vital--${name.toLowerCase()}`}><dt>{stat?.[0] ?? name}</dt><dd>{knowledgeLabel(stat?.[1].value ?? UNKNOWN)}</dd></div>
  }
  return <div className="member-summary">
    <div className="member-summary__identity"><span className="member-portrait"><Icon name="character"/><MemberArtwork catalogs={catalogs} profile={profile} value={primary}/></span><div><h2>{character.name}</h2><span>{primary ? entityName(profile, catalogs, primary) : `Class: ${knowledgeLabel(snapshot?.primaryClass ?? UNKNOWN)}`}</span></div></div>
    <dl className="member-vitals">{vital('HP')}{vital('MP')}<div className="member-vital member-vital--level"><dt>Lv</dt><dd>{knowledgeLabel(snapshot?.level ?? UNKNOWN)}</dd></div><div className="member-vital"><dt>LP</dt><dd>{knowledgeLabel(progress?.observedLp ?? UNKNOWN)}</dd></div></dl>
    <span className="member-state">{historical ? 'Historical' : 'Recorded'}</span>
  </div>
}

function SelectionDetails({ option, empty }: { option?: DefinitionOption; empty?: string }) {
  const navigation = useNavigation()
  if (!option) return <div className="member-detail"><h3>{empty ?? 'Selection details'}</h3><p>Choose a row to inspect its recorded selection. Unknown means it has not been confirmed; empty means the slot was checked.</p></div>
  const ref = option.ref
  const fields = Object.entries(option.record.fields).filter(([key]) => DETAIL_FIELDS.test(key))
  return <div className="member-detail">
    <div className="member-detail__title">{ref.kind === 'catalog' && <WikiSprite catalogId={ref.catalogId} entity={{ id: ref.entityId, kind: option.kind, name: option.name }}/>}<h3>{option.name}</h3></div>
    <span className="member-detail__kind">{option.kind === 'class' ? 'Class reference' : 'Definition reference'}</span>
    {option.description && <p>{option.description}</p>}
    <dl className="member-detail__facts">{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd><KnowledgeValue field={label} value={value}/></dd></div>)}</dl>
    {option.ppCost && option.ppCost.state !== 'notApplicable' && <p>PP: <KnowledgeValue value={option.ppCost}/></p>}
    {option.modAvailability?.requiredMod && <p className="member-detail__availability">{modAvailabilityLabel(option.modAvailability)}</p>}
    <details className="member-detail__sources"><summary>Sources & definition</summary><p>{option.sourceLabel}</p><SourceReferences sources={option.record.sources}/><FieldIconSources fields={option.record.fields}/>{ref.kind === 'catalog' && <WikiSpriteSource catalogId={ref.catalogId} entity={{ id: ref.entityId, kind: option.kind, name: option.name }}/>}<Button onClick={() => navigation.navigate({ page: { page: 'reference', view: 'detail', ref }, overlays: [], query: {} })} tone="quiet" type="button">Open full reference</Button></details>
  </div>
}

function MemberChoice({ fieldKey, label, value, display, allowedKinds, editable, selected, onInspect, onChange, children }: {
  fieldKey: string; label: string; value?: EntityRef | null; display: string; allowedKinds: readonly CatalogEntityKind[]; editable: boolean; selected: boolean
  onInspect: (option?: DefinitionOption) => void; onChange: (value: EntityRef | null | undefined) => void; children?: ReactNode
}) {
  const { profile, catalogs, options } = useDefinitionWorkspace()
  const navigation = useNavigation()
  const id = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const picker = currentMemberPicker(navigation.route)
  const open = editable && picker?.fieldKey === fieldKey
  const option = findDefinitionOption(options, value)
  const inspect = () => onInspect(option)
  const preview = () => { if (window.matchMedia(DESKTOP_MEMBER_QUERY).matches) inspect() }
  const optionLabel = (candidate: DefinitionOption) => fieldKey === SECONDARY_CLASS ? commandName(candidate) ?? candidate.name : candidate.name
  const choose = () => {
    inspect()
    if (!editable) return
    if (open) navigation.close()
    else navigation.navigate(routeWithOverlay(routeWithoutOverlays(navigation.route), { kind: 'definition-picker', fieldKey, query: '', resultLimit: PICKER_PAGE_SIZE }), { replace: Boolean(picker) })
  }
  return <div className="member-choice">
    <button aria-controls={open ? id : undefined} aria-expanded={editable ? open : undefined} aria-haspopup={editable ? 'dialog' : undefined} aria-label={`${editable ? 'Choose' : 'Inspect'} ${label}`} className="member-row" data-active={selected} data-definition-trigger="true" onClick={choose} onFocus={preview} onPointerEnter={preview} onKeyDown={event => { if (editable && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); if (!open) choose() } }} ref={triggerRef} type="button"><span className="member-row__label">{label}</span><span className="member-row__value"><MemberArtwork catalogs={catalogs} profile={profile} value={value}/><span>{display}</span>{editable && <Icon name="chevron-down"/>}</span></button>
    {children}
    {selected && <details className="member-mobile-detail"><summary>About {option?.name ?? label}</summary><SelectionDetails empty={display} option={option}/></details>}
    <DefinitionDropdown allowEmpty={fieldKey !== PRIMARY_CLASS} allowedKinds={allowedKinds} anchorRef={triggerRef} compact emptyDescription={fieldKey === SECONDARY_CLASS ? 'No sub-command applies to this observation' : undefined} emptyLabel={fieldKey === SECONDARY_CLASS ? 'Not applicable' : undefined} filterOption={candidate => matchesSlot(candidate, label)} id={id} onClose={() => navigation.close()} onInspect={onInspect} onSelect={onChange} open={open} optionLabel={optionLabel} selected={value} title={`Choose ${label}`}/>
  </div>
}

export function MemberSheet({ profile, catalogs, snapshot, hasPendingSave, onSave, onRecord, onLearn, onDirtyChange, onRetrySave }: {
  profile: Profile; catalogs: readonly CatalogSnapshot[]; snapshot: CharacterSnapshot
  hasPendingSave: boolean; onRetrySave: () => Promise<void>; onSave: (draft: SnapshotDraft) => Promise<void>; onDirtyChange: (dirty: boolean) => void; onRecord: () => void; onLearn: () => void
}) {
  const navigation = useNavigation()
  const { options } = useDefinitionWorkspace()
  const [draft, setDraft] = useState(() => ({ primaryClass: snapshot.primaryClass, secondaryClass: snapshot.secondaryClass, selections: snapshot.selections }))
  const [active, setActive] = useState(PRIMARY_CLASS)
  const [inspected, setInspected] = useState<DefinitionOption>()
  const [passivesOpen, setPassivesOpen] = useState(false)
  const [statusOpen, setStatusOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [warning, setWarning] = useState(false)
  const [note, setNote] = useState('')
  const submissionBase = useRef(snapshot.id)
  const retained = Boolean(error && snapshot.id !== submissionBase.current)
  const [savedDraft, setSavedDraft] = useState(draft)
  const dirty = JSON.stringify(draft) !== JSON.stringify(savedDraft) || note !== ''
  useEffect(() => { onDirtyChange(dirty || busy); return () => onDirtyChange(false) }, [dirty, busy, onDirtyChange])
  const synchronizedSnapshot = useRef(snapshot.id)
  useEffect(() => {
    if (synchronizedSnapshot.current === snapshot.id || dirty || busy) return
    synchronizedSnapshot.current = snapshot.id
    const next = { primaryClass: snapshot.primaryClass, secondaryClass: snapshot.secondaryClass, selections: snapshot.selections }
    setDraft(next)
    setSavedDraft(next)
    setInspected(undefined)
    setActive(PRIMARY_CLASS)
  }, [snapshot, dirty, busy])
  const blocked = useRef(false)
  blocked.current = dirty || busy
  useEffect(() => {
    if (!retained || hasPendingSave || busy) return
    setError(undefined)
    setSavedDraft(draft)
    setNote('')
    setWarning(false)
    blocked.current = false
  }, [retained, hasPendingSave, busy, draft])
  useNavigationBlocker(routeWithoutOverlays(navigation.route), () => blocked.current, () => setWarning(true))
  useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => { if (blocked.current) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', leave)
    return () => window.removeEventListener('beforeunload', leave)
  }, [])
  const ruleset = snapshot.rulesetRevisionId ? ownRecordValue(profile.rulesets, snapshot.rulesetRevisionId) : undefined
  const editable = Boolean(ruleset && ruleset.id === profile.activeRulesetRevisionId) && !busy && !retained
  const slots = snapshotSlots(profile, { ...snapshot, ...draft })
  const passives = slots.filter(slot => slot.kind === 'passive')
  const picker = currentMemberPicker(navigation.route)
  const requestedPassive = passives.some(slot => picker?.fieldKey === `slot:${slot.id}`)
  useEffect(() => { if (requestedPassive) setPassivesOpen(true) }, [requestedPassive])
  const primaryOption = findDefinitionOption(options, knownRef(draft.primaryClass))
  const primaryCommand = primaryOption && Object.entries(primaryOption.record.fields).find(([key]) => key.toLowerCase() === 'command')?.[1]
  const selectedOption = active === PRIMARY_CLASS ? inspected ?? primaryOption : inspected
  const display = (value: EntityRef | null | undefined) => value === null ? 'Empty' : value ? entityName(profile, catalogs, value) : 'Unknown'
  const inspect = (key: string, option?: DefinitionOption) => { setActive(key); setInspected(option) }
  const changeClass = (key: 'primaryClass' | 'secondaryClass', value: EntityRef | null | undefined) => setDraft(current => ({ ...current, [key]: value ? { state: 'known', value } : value === null ? { state: 'notApplicable' } : UNKNOWN }))
  const classField = (key: 'primaryClass' | 'secondaryClass', fieldKey: string, label: string) => {
    const value = draft[key]
    const ref = knownRef(value)
    const option = findDefinitionOption(options, ref)
    const name = fieldKey === SECONDARY_CLASS && option ? commandName(option) ?? option.name : ref ? display(ref) : knowledgeLabel(value)
    return <MemberChoice allowedKinds={CLASS_KINDS} display={name} editable={editable} fieldKey={fieldKey} label={label} onChange={value => changeClass(key, value)} onInspect={option => inspect(fieldKey, option)} selected={active === fieldKey} value={value.state === 'notApplicable' ? null : ref}/>
  }
  const slotField = (slot: SnapshotSlot) => {
    const key = `slot:${slot.id}`
    const configured = ruleset?.slots.find(entry => entry.id === slot.id)
    const allowedKinds = configured?.acceptedEntityKinds?.state === 'known' && configured.acceptedEntityKinds.value.length ? configured.acceptedEntityKinds.value : slot.kind === 'passive' ? PASSIVE_KINDS : ITEM_KINDS
    const availability = slot.selection && definitionModAvailability(profile, slot.selection, ruleset)
    return <MemberChoice allowedKinds={allowedKinds} display={display(slot.selection)} editable={editable && slot.kind !== 'unmapped'} fieldKey={key} key={slot.id} label={slot.label} onChange={value => setDraft(current => {
      const selections = { ...current.selections }
      if (value === undefined) delete selections[slot.id]
      else selections[slot.id] = value
      return { ...current, selections }
    })} onInspect={option => inspect(key, option)} selected={active === key} value={slot.selection}>{availability?.requiredMod && <RecordedModStatus availability={availability} className="member-slot-warning"/>}</MemberChoice>
  }
  const save = async () => {
    setBusy(true)
    if (!retained) submissionBase.current = snapshot.id
    try {
      if (retained) await onRetrySave()
      else await onSave({ ...draft, rulesetRevisionId: snapshot.rulesetRevisionId, level: snapshot.level, ppCapacity: snapshot.ppCapacity, displayedStats: snapshot.displayedStats, note: note.trim() || undefined })
      setError(undefined)
      setSavedDraft(draft)
      setNote('')
      setWarning(false)
      blocked.current = false
    } catch (reason) { setError(formatAppError(reason, 'The observation could not be saved.')) } finally { setBusy(false) }
  }
  return <div className="recorded-sheet member-sheet">
    {warning && <InlineNotice title="Unsaved member changes" tone="warning">Save changes or discard them before leaving this member.</InlineNotice>}
    {!ruleset || ruleset.id !== profile.activeRulesetRevisionId ? <InlineNotice title="Slot context has changed">Capture a new snapshot to record selections under the active ruleset. This observation keeps its original slot labels. <Button disabled={dirty || busy} onClick={onRecord} tone="quiet">Record under active ruleset</Button></InlineNotice> : null}
    <div className="member-sheet__layout">
      <section aria-label="Equipment and equipped passives" className="member-menu">
        <div className="member-menu__group">{classField('primaryClass', PRIMARY_CLASS, 'Class')}<div className="member-row member-row--static"><span className="member-row__label">Command</span><span className="member-row__value">{primaryCommand ? <KnowledgeValue compact field="Command" value={primaryCommand}/> : 'Unknown'}</span></div>{classField('secondaryClass', SECONDARY_CLASS, 'Sub-Command')}</div>
        <div className="member-menu__group">{slots.filter(slot => slot.kind !== 'passive').map(slotField)}{slots.length === 0 && <p className="recorded-empty">No equipment slots recorded.</p>}</div>
        <div className="member-menu__group"><button aria-expanded={passivesOpen || requestedPassive} className="member-row" onClick={() => setPassivesOpen(value => !value)} type="button"><span className="member-row__label">Passives</span><span className="member-row__value member-passives">{passives.map(slot => <span className="member-passive" data-state={slot.selection === undefined ? 'unknown' : slot.selection === null ? 'empty' : 'equipped'} key={slot.id} title={`${slot.label}: ${display(slot.selection)}`}><Icon name="crystal"/></span>)}<span className="sr-only">{passives.map(slot => `${slot.label}: ${display(slot.selection)}`).join('; ')}</span><Icon name="chevron-down"/></span></button>{(passivesOpen || requestedPassive) && <div className="member-passive-list"><p>PP capacity: {knowledgeLabel(snapshot.ppCapacity)}</p>{passives.map(slotField)}</div>}
          <button className="member-row" onClick={onLearn} type="button"><span className="member-row__label">Learn</span><span className="member-row__value">Classes & skills<Icon name="tome"/></span></button>
          <button aria-expanded={statusOpen} className="member-row" onClick={() => setStatusOpen(value => !value)} type="button"><span className="member-row__label">Status</span><span className="member-row__value">Recorded stats<Icon name="chevron-down"/></span></button>
        </div>
      </section>
      <aside aria-label="Selection details" className="member-inspector"><SelectionDetails empty={active === PRIMARY_CLASS ? 'Class unknown' : undefined} option={selectedOption}/></aside>
    </div>
    {statusOpen && <section aria-label="Displayed final stats" className="member-status"><div className="split"><h3>Status</h3><Button disabled={dirty || busy} onClick={onRecord} tone="quiet">Record status</Button></div><p>Displayed totals from this observation.</p><dl className="recorded-stats"><div><dt>Level</dt><dd>{knowledgeLabel(snapshot.level)}</dd></div><div><dt>PP capacity</dt><dd>{knowledgeLabel(snapshot.ppCapacity)}</dd></div>{Object.entries(snapshot.displayedStats).map(([key, stat]) => <div key={key}><dt>{key}</dt><dd><SnapshotValueView catalogs={catalogs} profile={profile} value={{ kind: 'number', ...stat }}/></dd></div>)}</dl>{!Object.keys(snapshot.displayedStats).length && <p>No displayed stats recorded.</p>}</section>}
    {picker && ![PRIMARY_CLASS, SECONDARY_CLASS, ...slots.map(slot => `slot:${slot.id}`)].includes(picker.fieldKey) && <InlineNotice title="Character field unavailable" tone="warning">The requested slot is not in this observation. <Button onClick={() => navigation.close()} tone="quiet">Close picker route</Button></InlineNotice>}
    {dirty && <div className="member-save"><div><strong>Unsaved observation</strong><small>Save after confirming these selections in game. Displayed stats retain their recorded values.</small></div><label className="sr-only" htmlFor="member-note">Snapshot note</label><input disabled={busy || retained} id="member-note" onChange={event => setNote(event.target.value)} placeholder="Optional note" value={note}/><div><Button disabled={busy || retained} onClick={() => { setDraft(savedDraft); setNote(''); setWarning(false); setError(undefined); blocked.current = false }} tone="quiet">Discard changes</Button><Button disabled={busy} onClick={() => void save()}>{busy ? 'Saving...' : retained ? 'Retry member save' : 'Save changes'}</Button></div></div>}
    {error && <InlineNotice title="Snapshot not saved" tone="danger">{error} Your choices are retained for retry.</InlineNotice>}
    <details className="member-record"><summary>Observation details<span>{snapshot.observedAt ? formatRelativeDate(snapshot.observedAt) : 'Date unknown'}</span></summary><p>Recorded {formatRelativeDate(snapshot.recordedAt)}</p>{snapshot.note && <p>{snapshot.note}</p>}<p>{ruleset ? `${ruleset.label} · revision ${ruleset.revision}` : 'Slot context was not recorded'}</p><dl className="definition-list"><div className="definition-row"><dt>Enabled mods</dt><dd><KnowledgeValue showSources value={ruleset?.mods ?? UNKNOWN}/></dd></div><div className="definition-row"><dt>Disabled mods</dt><dd><KnowledgeValue showSources value={ruleset?.disabledMods ?? UNKNOWN}/></dd></div></dl><SourceReferences sources={snapshot.sources}/><SnapshotValueView catalogs={catalogs} profile={profile} ruleset={ruleset} value={{ kind: 'reference', value: snapshot.primaryClass }}/><SnapshotValueView catalogs={catalogs} profile={profile} ruleset={ruleset} value={{ kind: 'reference', value: snapshot.secondaryClass }}/>{slots.map(slot => <div key={slot.id}><span>{slot.label}: </span><SnapshotValueView catalogs={catalogs} profile={profile} ruleset={ruleset} value={{ kind: 'selection', value: slot.selection }}/></div>)}</details>
  </div>
}
