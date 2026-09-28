import { equipmentRole, EQUIPMENT_ROLE_LABELS } from '../domain/mechanics-facts'
import type { EquipmentRole } from '../domain/types'
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import type { CatalogEntityKind, Knowledge, Profile, RulesetRevisionId, SlotDefinition, SlotId, SlotProvenance, SourceRef } from '../domain/types'
import { DEFAULT_PP_LIMIT } from '../domain/profile'
import { SUGGESTED_BUILD_SLOTS } from '../domain/build-planning'
import { modState, normalizeModName, recordedModNames, updateModSelections, type ModConfiguration, type ModSelection } from '../domain/mods'
import { CONFIRMED_SWITCH_MOD_SETUP, SWITCH_MOD_PACKS } from '../catalog/mods'
import { AppDataError, MAX_IMPORT_BYTES } from '../interchange'
import type { ImportCommitMode, ImportPreview, ProfileSummary } from '../interchange/types'
import { activateOfflineUpdate, getOfflineStatus, requestOfflineReadiness, requestPersistentStorage, subscribeOfflineStatus, type OfflineStatus } from '../offline'
import { Badge, Button, DefinitionRow, Field, InlineNotice, Spinner } from './components'
import { Icon } from './icons'
import { activeRuleset, downloadBytes, formatAppError, formatRelativeDate, ownRecordValue } from './model'
import { useNavigation, useNavigationBlocker, type SettingsSection } from './navigation'
import { CorrectionsButton } from './Corrections'
import { Sheet } from './Sheet'
import { CreditsSection } from './CreditsSection'

const IMPORT_WARNING_PRIMARY_COUNT = 8
const IMPORT_WARNING_DOM_LIMIT = 100

export interface RulesetDraft {
  readonly sourceRulesetRevisionId?: RulesetRevisionId
  readonly label: string
  readonly platform: Knowledge<string>
  readonly gameVersion: Knowledge<string>
  readonly mode: Knowledge<string>
  readonly mods: Knowledge<readonly string[]>
  readonly disabledMods?: Knowledge<readonly string[]>
  readonly ppLimit: Knowledge<number>
  readonly ppCostsNonNegative: Knowledge<boolean>
  readonly slots: readonly { readonly id?: SlotId; readonly label: string; readonly equipmentRole?: EquipmentRole | null; readonly acceptedEntityKinds?: Knowledge<readonly CatalogEntityKind[]>; readonly provenance: SlotProvenance; readonly sources: readonly SourceRef[] }[]
}

function ImportWorkspace({ profile, preview, importError, busy, disabled, onPreview, onCommit, onClear }: { profile: Profile; preview?: ImportPreview; importError?: string; busy: boolean; disabled: boolean; onPreview: (bytes: Uint8Array, filename: string) => Promise<void>; onCommit: (preview: ImportPreview, mode: ImportCommitMode, restoreCorrections?: boolean) => Promise<void>; onClear: () => void }) {
  const [mode, setMode] = useState<ImportCommitMode>(preview?.detectedFormat === 'crystal-edit-json-1' ? 'add-reference' : 'new-profile')
  const [replaceConfirmed, setReplaceConfirmed] = useState(false)
  const [restoreCorrections, setRestoreCorrections] = useState(false)
  const [readError, setReadError] = useState<string>()
  const inputRef = useRef<HTMLInputElement>(null)
  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file || disabled) return
    setReadError(undefined)
    if (file.size === 0 || file.size > MAX_IMPORT_BYTES) {
      const message = file.size === 0 ? 'The selected file is empty' : `The selected file exceeds the ${MAX_IMPORT_BYTES / (1024 * 1024)} MiB local import limit`
      setReadError(formatAppError(new AppDataError('unsupported-format', message, { details: { size: file.size, limit: MAX_IMPORT_BYTES } }), 'The selected file could not be read.'))
      event.target.value = ''
      return
    }
    try { await onPreview(new Uint8Array(await file.arrayBuffer()), file.name) } catch (reason) { setReadError(formatAppError(reason, 'The selected file could not be read.')) } finally { event.target.value = '' }
  }
  if (preview) {
    const displayedWarnings = preview.warnings.slice(0, IMPORT_WARNING_DOM_LIMIT)
    const primaryWarnings = displayedWarnings.slice(0, IMPORT_WARNING_PRIMARY_COUNT)
    const additionalWarnings = displayedWarnings.slice(IMPORT_WARNING_PRIMARY_COUNT)
    const omittedWarnings = preview.warnings.length - displayedWarnings.length
    return <div className="import-preview">{(importError || readError) && <InlineNotice title="Data operation could not be completed" tone="danger">{importError ?? readError} The preview and current profile remain available.</InlineNotice>}<div className="split"><div><p className="eyebrow">Import preview</p><h3>{preview.filename}</h3></div><Button onClick={() => { setMode('new-profile'); setReplaceConfirmed(false); setReadError(undefined); onClear() }} tone="quiet">Choose another file</Button></div><dl className="definition-list"><DefinitionRow term="Detected format">{preview.detectedFormat}</DefinitionRow><DefinitionRow term="Schema">{preview.detectedSchema}</DefinitionRow><DefinitionRow term="Profile label">{preview.profile.label}</DefinitionRow><DefinitionRow term="Identity">{preview.profile.identity ?? 'No source profile identity'}</DefinitionRow></dl><div className="import-preview__counts"><div className="metric"><span className="metric__label">Reference records</span><span className="metric__value">{preview.counts.reference}</span><span className="metric__detail">Definitions and claims</span></div><div className="metric"><span className="metric__label">Personal records</span><span className="metric__value">{preview.counts.personal}</span><span className="metric__detail">Observations and plans</span></div></div>{preview.errors.map((problem) => <InlineNotice key={`${problem.code}:${problem.locator}`} title={problem.code} tone="danger">{problem.message}</InlineNotice>)}{primaryWarnings.map((problem) => <InlineNotice key={`${problem.code}:${problem.locator}`} title={problem.code} tone="warning">{problem.message}</InlineNotice>)}{additionalWarnings.length > 0 && <details><summary>{additionalWarnings.length} more warnings</summary><div className="stack">{additionalWarnings.map((problem) => <p key={`${problem.code}:${problem.locator}`}>{problem.message}</p>)}</div></details>}{omittedWarnings > 0 && <InlineNotice title="Additional warnings omitted" tone="warning">{omittedWarnings.toLocaleString()} additional warnings are not rendered in this preview.</InlineNotice>}<details><summary>Source and coverage details</summary><dl className="definition-list"><DefinitionRow term="Source digest">{preview.sourceDigest}</DefinitionRow><DefinitionRow term="Catalog snapshots">{preview.proposed.catalogs.length}</DefinitionRow><DefinitionRow term="Evidence records">{preview.proposed.evidence.length}</DefinitionRow><DefinitionRow term="Ignored rows">{preview.counts.ignored}</DefinitionRow></dl></details><Field hint={mode === 'add-reference' ? 'Adds this catalog and its source file. Personal records and saved rulesets stay intact.' : mode === 'replace' ? 'The current profile is replaced only after a successful transaction.' : 'Safest when identity or ancestry is uncertain.'} label="Import action"><select onChange={(event) => { setMode(event.target.value as ImportCommitMode); setReplaceConfirmed(false) }} value={mode}><>{preview.detectedFormat === 'crystal-edit-json-1' && <option value="add-reference">Add references to {profile.label}</option>}</><option value="new-profile">Create a new profile</option><option value="replace">Replace {profile.label}</option></select></Field>{mode === 'replace' && <label className="check-row"><input checked={replaceConfirmed} onChange={(event) => setReplaceConfirmed(event.target.checked)} type="checkbox"/><span><strong>Replace the current profile after validation</strong><small>The current profile stays unchanged if the transaction fails</small></span></label>}<>{preview.proposed.corrections?.entries.length ? <label className="check-row"><input checked={restoreCorrections} onChange={event => setRestoreCorrections(event.target.checked)} type="checkbox"/><span>Restore reference corrections from this backup<small>Merge decision history across playthroughs. Competing corrections stay pending for an explicit choice.</small></span></label> : null}</><Button disabled={busy || disabled || preview.errors.length > 0 || (mode === 'replace' && !replaceConfirmed)} icon="check" onClick={() => void onCommit(preview, mode, restoreCorrections)}>{busy ? 'Importing...' : mode === 'add-reference' ? 'Add references' : mode === 'replace' ? 'Replace profile' : 'Create profile'}</Button></div>
  }
  return <div className="stack">{(importError || readError) && <InlineNotice title="Data operation could not be completed" tone="danger">{importError ?? readError} Your existing profile has not been replaced.</InlineNotice>}<button className="import-zone" disabled={busy || disabled} onClick={() => inputRef.current?.click()} type="button">{busy ? <Spinner label="Reading import"/> : <><Icon name="upload"/><span><strong>Choose a JSON, ZIP, or workbook</strong><span>The file is validated and previewed before any write.</span></span></>}</button><input accept=".json,.zip,.xlsx,application/json,application/zip,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" aria-label="Choose import file" className="sr-only" onChange={(event) => void choose(event)} ref={inputRef} type="file"/><InlineNotice title="Private local import">Imported personal records and evidence stay in this browser. No file is uploaded.</InlineNotice></div>
}

const RULESET_ENTITY_KINDS: readonly CatalogEntityKind[] = ['item', 'class', 'ability', 'passive', 'innate', 'monsterMagic', 'monster', 'command', 'recipe', 'location', 'other']
const SWITCH_MOD_NAMES = new Set(SWITCH_MOD_PACKS.flatMap(pack => pack.mods.map(normalizeModName)))

type RulesetFocus = 'setup' | 'slots'

interface EditableRulesetSlot {
  readonly id?: SlotId
  readonly label: string
  readonly equipmentRole?: EquipmentRole | null
  readonly acceptedKinds: string
  readonly acceptedKindsTouched: boolean
  readonly acceptedEntityKinds?: Knowledge<readonly CatalogEntityKind[]>
  readonly provenance: SlotProvenance
  readonly sources: readonly SourceRef[]
}

function editableSlot(slot: SlotDefinition): EditableRulesetSlot {
  return { id: slot.id, label: slot.label, equipmentRole: slot.equipmentRole === null ? null : equipmentRole(slot), acceptedKinds: slot.acceptedEntityKinds?.state === 'known' ? slot.acceptedEntityKinds.value.join(', ') : '', acceptedKindsTouched: false, acceptedEntityKinds: slot.acceptedEntityKinds, provenance: slot.provenance, sources: slot.sources }
}

function userDefinedSlot(slot: EditableRulesetSlot): EditableRulesetSlot {
  return { ...slot, provenance: 'userDefined', sources: [] }
}

function RulesetForm({ profile, sourceRulesetRevisionId, focus, saveError, onSubmit, onDirty }: { profile: Profile; sourceRulesetRevisionId?: RulesetRevisionId; focus?: RulesetFocus; saveError?: string; onSubmit: (draft: RulesetDraft) => Promise<void>; onDirty: (dirty: boolean) => void }) {
  const current = sourceRulesetRevisionId ? ownRecordValue(profile.rulesets, sourceRulesetRevisionId) : activeRuleset(profile)
  const [label, setLabel] = useState(current?.label ?? '')
  const [platform, setPlatform] = useState(current?.platform.state === 'known' ? current.platform.value : '')
  const [version, setVersion] = useState(current?.gameVersion.state === 'known' ? current.gameVersion.value : '')
  const [mode, setMode] = useState(current?.mode.state === 'known' ? current.mode.value : '')
  const [modConfiguration, setModConfiguration] = useState<ModConfiguration>({ mods: current?.mods ?? { state: 'unknown' }, disabledMods: current?.disabledMods })
  const [touched, setTouched] = useState({ platform: false, version: false, mode: false })
  const [ppLimit, setPpLimit] = useState<Knowledge<number>>(current?.ppLimit ?? { state: 'known', value: DEFAULT_PP_LIMIT })
  const [ppCostsNonNegative, setPpCostsNonNegative] = useState<Knowledge<boolean>>(current?.ppCostsNonNegative ?? { state: 'unknown' })
  const [slots, setSlots] = useState<EditableRulesetSlot[]>(current?.slots.map(editableSlot) ?? [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const setupRef = useRef<HTMLDivElement>(null)
  const slotsRef = useRef<HTMLElement>(null)
  const stringKnowledge = (value: string): Knowledge<string> => value.trim() ? { state: 'known', value: value.trim() } : { state: 'unknown' }
  const preservedHint = (value: Knowledge<unknown> | undefined) => value?.state === 'conflicting' ? 'Conflicting imported claims are preserved until you edit this field.' : value?.state === 'notApplicable' ? 'The imported not-applicable state is preserved until you edit this field.' : undefined
  useEffect(() => {
    if (!focus) return
    const frame = window.requestAnimationFrame(() => {
      const target = focus === 'setup' ? setupRef.current : slotsRef.current
      target?.scrollIntoView({ block: 'start' })
      target?.querySelector<HTMLElement>('input, select, button')?.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [focus])
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError(undefined)
    const preparedSlots = slots.map((slot) => {
      const tokens = slot.acceptedKinds.split(',').map((value) => value.trim()).filter(Boolean)
      const invalidTokens = slot.acceptedKindsTouched ? tokens.filter((value) => !RULESET_ENTITY_KINDS.includes(value as CatalogEntityKind)) : []
      const acceptedKinds = tokens.filter((value): value is CatalogEntityKind => RULESET_ENTITY_KINDS.includes(value as CatalogEntityKind))
      return { slot, invalidTokens, acceptedKinds }
    })
    const invalidTokens = [...new Set(preparedSlots.flatMap((entry) => entry.invalidTokens))]
    if (invalidTokens.length > 0) {
      setError(`Accepted types contain unsupported values: ${invalidTokens.join(', ')}. Use only ${RULESET_ENTITY_KINDS.join(', ')}.`)
      return
    }
    setBusy(true)
    try {
      await onSubmit({
        sourceRulesetRevisionId: current?.id,
        label,
        platform: touched.platform ? stringKnowledge(platform) : current?.platform ?? { state: 'unknown' },
        gameVersion: touched.version ? stringKnowledge(version) : current?.gameVersion ?? { state: 'unknown' },
        mode: touched.mode ? stringKnowledge(mode) : current?.mode ?? { state: 'unknown' },
        ...modConfiguration,
        ppLimit,
        ppCostsNonNegative,
        slots: preparedSlots.filter(({ slot }) => slot.label.trim()).map(({ slot, acceptedKinds }) => ({ id: slot.id, label: slot.label, equipmentRole: slot.equipmentRole, acceptedEntityKinds: slot.acceptedKindsTouched ? acceptedKinds.length ? { state: 'known', value: acceptedKinds } : { state: 'unknown' } : slot.acceptedEntityKinds, provenance: slot.provenance, sources: slot.sources })),
      })
      onDirty(false)
    } catch (reason) {
      setError(formatAppError(reason, 'The ruleset revision could not be saved.'))
    } finally {
      setBusy(false)
    }
  }
  const addSlot = () => setSlots((values) => [...values, { label: '', acceptedKinds: '', acceptedKindsTouched: true, provenance: 'userDefined', sources: [] }])
  const acceptPlannerLayout = () => {
    setSlots(values => (values.length ? values : SUGGESTED_BUILD_SLOTS.map(editableSlot)).map(slot => slot.provenance === 'suggested' ? userDefinedSlot(slot) : slot))
    onDirty(true)
  }
  const useConfirmedModSetup = () => {
    setPlatform(CONFIRMED_SWITCH_MOD_SETUP.platform)
    setModConfiguration(value => updateModSelections(value, [
      ...CONFIRMED_SWITCH_MOD_SETUP.enabledMods.map(name => ({ name, state: 'enabled' as const })),
      ...CONFIRMED_SWITCH_MOD_SETUP.disabledMods.map(name => ({ name, state: 'disabled' as const })),
    ]))
    setTouched(value => ({ ...value, platform: true }))
    onDirty(true)
  }
  const otherMods = recordedModNames(modConfiguration).filter(name => !SWITCH_MOD_NAMES.has(normalizeModName(name)))
  const hasSuggestedSlots = slots.some(slot => slot.provenance === 'suggested')
  const ppLimitState = ppLimit.state === 'known' ? 'known' : ppLimit.state
  const ppValue = ppCostsNonNegative.state === 'known' ? String(ppCostsNonNegative.value) : ppCostsNonNegative.state
  return <form className="stack" onInput={() => onDirty(true)} onSubmit={submit}>
    <InlineNotice title="Version fields may stay unknown">Missing configuration limits only the checks that depend on it; inventory entry and independent validation remain useful. Imported conflicting claims remain intact unless you edit their field.</InlineNotice>
    <p className="settings-section__intro">{current ? `Editing ${current.label}, revision ${current.revision}. ` : ''}Saving creates a new active revision with the built-in names catalog available for selection. Existing build revisions and team scenarios remain pinned to their saved ruleset.</p>
    <Field label="Ruleset label" required><input onChange={(event) => setLabel(event.target.value)} placeholder="For example: Switch playthrough" required value={label}/></Field>
    <div className="stack" data-ruleset-focus="setup" ref={setupRef}><div className="grid-3"><Field hint={preservedHint(current?.platform)} label="Platform"><input onChange={(event) => { setPlatform(event.target.value); setTouched((value) => ({ ...value, platform: true })) }} placeholder="Unknown" value={platform}/></Field><Field hint={preservedHint(current?.gameVersion)} label="Game version"><input onChange={(event) => { setVersion(event.target.value); setTouched((value) => ({ ...value, version: true })) }} placeholder="Unknown" value={version}/></Field><Field hint={preservedHint(current?.mode)} label="Mode"><input onChange={(event) => { setMode(event.target.value); setTouched((value) => ({ ...value, mode: true })) }} placeholder="Unknown" value={mode}/></Field></div>
    <div className="split ruleset-mod-heading"><div><h3>Switch mods for this playthrough</h3><p className="settings-section__intro">Choose which mods are enabled in your save. Both free Switch packs are listed below; installing a pack does not enable every mod. Unknown means you have not recorded that choice.</p></div><Button onClick={useConfirmedModSetup} tone="secondary" type="button">Use confirmed Switch setup</Button></div>
    <div className="grid-2 ruleset-mod-packs">{SWITCH_MOD_PACKS.map(pack => <fieldset className="ruleset-mod-pack" key={pack.id}><legend>{pack.name}</legend>{pack.mods.map(name => {
      const state = modState(modConfiguration, name)
      return <label className="ruleset-mod-choice" key={name}><span>{name}</span><select aria-label={name} data-mod-state={state} onChange={event => { setModConfiguration(value => updateModSelections(value, [{ name, state: event.target.value as ModSelection['state'] }])); onDirty(true) }} value={state}><option value="unknown">Unknown</option><option value="enabled">Enabled</option><option value="disabled">Disabled</option>{state === 'conflicting' && <option disabled value="conflicting">Conflicting</option>}</select></label>
    })}</fieldset>)}</div>
    {otherMods.length > 0 && <details><summary>Other imported mod names (preserved)</summary><p className="settings-section__intro">These names are outside the supplied Switch list. Their recorded states are retained when you change Switch mods.</p><dl className="definition-list">{otherMods.map(name => <DefinitionRow key={name} term={name}>{modState(modConfiguration, name)}</DefinitionRow>)}</dl></details>}</div>
    <div className="grid-2"><div className="field"><span className="field__label">Total passive PP budget</span><select aria-label="Build PP limit certainty" onChange={(event) => setPpLimit(event.target.value === 'known' ? { state: 'known', value: DEFAULT_PP_LIMIT } : { state: 'unknown' })} value={ppLimitState}><option value="unknown">Unknown</option><option value="known">Known</option>{ppLimit.state === 'conflicting' && <option disabled value="conflicting">Conflicting claims</option>}{ppLimit.state === 'notApplicable' && <option disabled value="notApplicable">Not applicable</option>}</select>{ppLimit.state === 'known' && <input aria-label="Build PP limit" min="0" onChange={(event) => setPpLimit({ state: 'known', value: Number(event.target.value) })} type="number" value={ppLimit.value}/>}<span className="field__hint">One shared budget is spread across all equipped passives. It is not a passive count.</span></div><Field hint="This enables only the rule that documented PP costs cannot be negative." label="PP cost rule"><select onChange={(event) => setPpCostsNonNegative(event.target.value === 'true' ? { state: 'known', value: true } : event.target.value === 'false' ? { state: 'known', value: false } : { state: 'unknown' })} value={ppValue}><option value="unknown">Unknown</option><option value="true">Costs are nonnegative</option><option value="false">Negative costs permitted</option>{ppCostsNonNegative.state === 'conflicting' && <option disabled value="conflicting">Conflicting claims</option>}{ppCostsNonNegative.state === 'notApplicable' && <option disabled value="notApplicable">Not applicable</option>}</select></Field></div>
    <section className="settings-section stack" data-ruleset-focus="slots" ref={slotsRef}><div className="split"><div><h3>Ordered equipment slots</h3><p className="settings-section__intro">Only equipment uses configured slots. Equipped passives form a variable-length list constrained by the shared PP budget.</p></div><div className="cluster">{(hasSuggestedSlots || slots.length === 0) && <Button onClick={acceptPlannerLayout} tone="secondary" type="button">{slots.length ? 'Accept planner layout' : 'Use planner defaults'}</Button>}<Button icon="plus" onClick={addSlot} tone="secondary" type="button">Add equipment slot</Button></div></div>{hasSuggestedSlots && <InlineNotice title="Planner defaults are still in use">Review the displayed equipment slots or accept this layout for the new revision. Accepting records your choice; it does not claim independent verification of game behavior.</InlineNotice>}{slots.length ? slots.map((slot, index) => <div className="grid-3" key={slot.id ?? index}><Field label={`Equipment slot ${index + 1}`}><input onChange={(event) => setSlots((values) => values.map((value, itemIndex) => itemIndex === index ? userDefinedSlot({ ...value, label: event.target.value }) : value))} placeholder="Main hand" value={slot.label}/></Field><Field label="Equipment role"><select aria-label={`Slot ${index + 1} equipment role`} onChange={event => setSlots(values => values.map((value, itemIndex) => itemIndex === index ? userDefinedSlot({ ...value, equipmentRole: event.target.value as EquipmentRole || null }) : value))} value={slot.equipmentRole ?? ''}><option value="">Unspecified</option>{Object.entries(EQUIPMENT_ROLE_LABELS).map(([role, label]) => <option key={role} value={role}>{label}</option>)}</select></Field><Field hint={slot.acceptedEntityKinds?.state === 'conflicting' && !slot.acceptedKindsTouched ? 'Conflicting imported claims are preserved until edited.' : 'Comma-separated equipment definition types, normally item.'} label="Accepted types"><input onChange={(event) => setSlots((values) => values.map((value, itemIndex) => itemIndex === index ? userDefinedSlot({ ...value, acceptedKinds: event.target.value, acceptedKindsTouched: true }) : value))} placeholder="item" value={slot.acceptedKinds}/></Field></div>) : <InlineNotice title="No equipment slots configured">Add only the ordered equipment slots established for this game configuration.</InlineNotice>}</section>
    {(error || saveError) && <InlineNotice title="Ruleset not saved" tone="danger">{error ?? saveError} Your configuration remains in this form.{saveError && ' Close this panel and use Retry save to keep the retained revision.'}</InlineNotice>}
    <div className="form-actions"><Button disabled={busy || !label.trim()} icon="check" type="submit">{busy ? 'Saving...' : current ? 'Save new ruleset revision' : 'Create ruleset'}</Button></div>
  </form>
}

function StorageSection({ profile, dirty, saveError, onExport }: { profile: Profile; dirty: boolean; saveError?: string; onExport: () => Promise<Uint8Array> }) {
  const [offline, setOffline] = useState<OfflineStatus>({ state: 'checking' })
  const [busy, setBusy] = useState(false)
  const [persisted, setPersisted] = useState<boolean>()
  const [exportError, setExportError] = useState<string>()
  const [storageError, setStorageError] = useState<string>()
  useEffect(() => { const unsubscribe = subscribeOfflineStatus(setOffline); void getOfflineStatus().then(setOffline).catch(() => setStorageError('Offline readiness could not be inspected.')); return unsubscribe }, [])
  const prepareOffline = async () => { setBusy(true); setStorageError(undefined); try { setOffline(await requestOfflineReadiness()) } catch (reason) { setStorageError(formatAppError(reason, 'Offline preparation could not be completed.')) } finally { setBusy(false) } }
  const requestPersistence = async () => { setBusy(true); setStorageError(undefined); try { setPersisted(await requestPersistentStorage()) } catch (reason) { setStorageError(formatAppError(reason, 'Persistent storage could not be requested.')) } finally { setBusy(false) } }
  const applyUpdate = async () => { setBusy(true); setStorageError(undefined); try { await activateOfflineUpdate() } catch (reason) { setStorageError(formatAppError(reason, 'The application update could not be activated.')) } finally { setBusy(false) } }
  const exportNow = async () => { setBusy(true); setExportError(undefined); try { downloadBytes(await onExport(), `crystal-companion-${profile.label.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-') || 'profile'}.zip`, 'application/zip') } catch (error) { setExportError(formatAppError(error, 'The backup could not be prepared.')) } finally { setBusy(false) } }
  return <div className="stack">{saveError && <InlineNotice title="Local save failed" tone="danger">{saveError} The retained transaction is included in a recovery backup. Fields still only in an unsubmitted form are not included.</InlineNotice>}{dirty && <InlineNotice title="Unsaved changes" tone="warning">Save or submit open form fields before exporting. Backups include retained failed-save transactions, but not fields that still exist only in a form.</InlineNotice>}{storageError && <InlineNotice title="Storage operation failed" tone="danger">{storageError}</InlineNotice>}<section className="settings-section"><div className="split"><div><h3>Portable backup</h3><p className="settings-section__intro">Create an explicit file for recovery or transfer.</p></div><Button disabled={busy} icon="download" onClick={() => void exportNow()}>Export backup</Button></div>{exportError && <InlineNotice title="Export failed" tone="danger">{exportError}</InlineNotice>}</section><section className="settings-section"><div className="split"><div><h3>Offline application</h3><p className="settings-section__intro">{offline.detail ?? 'Checking cached application files...'}</p></div><Badge tone={offline.state === 'ready' ? 'positive' : offline.state === 'error' ? 'danger' : 'warning'}>{offline.state === 'ready' ? 'Offline ready' : offline.state === 'checking' ? 'Checking' : offline.state === 'unsupported' ? 'Unsupported' : offline.state === 'error' ? 'Unavailable' : 'Not ready'}</Badge></div>{offline.state !== 'ready' && offline.state !== 'unsupported' && <Button disabled={busy} icon="download" onClick={() => void prepareOffline()} tone="secondary">Prepare for offline use</Button>}{offline.updateAvailable && <Button disabled={dirty} onClick={() => void applyUpdate()} tone="secondary">{dirty ? 'Save or discard changes before updating' : 'Apply app update'}</Button>}</section><section className="settings-section"><div className="split"><div><h3>Browser storage</h3><p className="settings-section__intro">Persistent storage can reduce eviction risk but is not a backup.</p></div>{persisted !== undefined && <Badge tone={persisted ? 'positive' : 'warning'}>{persisted ? 'Persistence granted' : 'Request not granted'}</Badge>}</div><Button disabled={busy} onClick={() => void requestPersistence()} tone="secondary">Request persistent storage</Button></section></div>
}

export function DataPanel({ open, profile, profiles, preview, importError, busy, canUndo, dirty, saveError, onClose, onPreview, onCommit, onClearPreview, onExport, onSaveRuleset, onCreateProfile, onSelectProfile, onUndo }: { open: boolean; profile: Profile; profiles: readonly ProfileSummary[]; preview?: ImportPreview; importError?: string; busy: boolean; canUndo: boolean; dirty: boolean; saveError?: string; onClose: () => void; onPreview: (bytes: Uint8Array, filename: string) => Promise<void>; onCommit: (preview: ImportPreview, mode: ImportCommitMode, restoreCorrections?: boolean) => Promise<void>; onClearPreview: () => void; onExport: () => Promise<Uint8Array>; onSaveRuleset: (draft: RulesetDraft) => Promise<void>; onCreateProfile: (label: string) => Promise<void>; onSelectProfile: (profileId: ProfileSummary['id']) => Promise<void>; onUndo: () => Promise<void> }) {
  const navigation = useNavigation()
  const settingsPage = navigation.route.page.page === 'settings' ? navigation.route.page : undefined
  const section = settingsPage?.section ?? 'data'
  const requestedPreviewId = settingsPage && 'previewId' in settingsPage ? settingsPage.previewId : undefined
  const activePreview = requestedPreviewId !== undefined && preview?.id === requestedPreviewId ? preview : undefined
  const missingPreview = requestedPreviewId !== undefined && !activePreview
  const requestedRulesetId = navigation.route.query.ruleset?.[0]
  const requestedRuleset = requestedRulesetId ? ownRecordValue(profile.rulesets, requestedRulesetId) : undefined
  const rulesetFocus = navigation.route.query.focus?.[0]
  const focus = rulesetFocus === 'setup' || rulesetFocus === 'slots' ? rulesetFocus : undefined
  const [panelError, setPanelError] = useState<string>()
  const [panelDirty, setPanelDirty] = useState(false)
  const panelDirtyRef = useRef(false)
  const [profileLabel, setProfileLabel] = useState('')
  const [profileBusy, setProfileBusy] = useState(false)
  const [undoConfirmed, setUndoConfirmed] = useState(false)
  const blocked = dirty || panelDirty
  const setRulesetDirty = (value: boolean) => { panelDirtyRef.current = value; setPanelDirty(value) }
  useNavigationBlocker({ page: { page: 'settings', section: 'ruleset' }, overlays: [], query: {} }, () => panelDirtyRef.current, () => setPanelError('Save the ruleset revision or close this panel to discard its edited fields.'))
  const changeSection = (next: SettingsSection) => {
    if (panelDirty && next !== section) {
      setPanelError('Save the ruleset revision or close this panel to discard its edited fields.')
      return
    }
    setPanelError(undefined)
    navigation.navigate({ page: { page: 'settings', section: next }, overlays: [], query: {} })
  }
  const exportBackupNow = async () => {
    setPanelError(undefined)
    try { downloadBytes(await onExport(), 'crystal-companion-backup.zip', 'application/zip') } catch (reason) { setPanelError(formatAppError(reason, 'The backup could not be prepared.')) }
  }
  const runProfileAction = async (action: () => Promise<void>) => {
    setProfileBusy(true)
    setPanelError(undefined)
    try { await action() } catch (reason) { setPanelError(formatAppError(reason, 'The profile operation could not be completed.')) } finally { setProfileBusy(false) }
  }
  const close = () => {
    setRulesetDirty(false)
    setPanelError(undefined)
    setUndoConfirmed(false)
    onClose()
  }
  const clearPreview = () => {
    onClearPreview()
  }
  return <Sheet description="Import, backup, rulesets, history, and browser storage controls." onClose={close} open={open} title="Data & settings" width="wide">
    <div className="data-nav" role="group" aria-label="Data and settings sections">{([{ id: 'data', label: 'Import & backup' }, { id: 'ruleset', label: 'Ruleset' }, { id: 'history', label: 'History' }, { id: 'storage', label: 'Offline & storage' }, { id: 'credits', label: 'Credits & licenses' }] as const).map((item) => <button aria-pressed={section === item.id} key={item.id} onClick={() => changeSection(item.id)} type="button">{item.label}</button>)}</div>
    {panelError && section !== 'ruleset' && <InlineNotice title="Data operation could not be completed" tone="danger">{panelError}</InlineNotice>}
    {section === 'data' && <div className="stack">
      <section className="settings-section"><h3>Local profiles</h3><p className="settings-section__intro">Keep build collections or playthroughs in separate local profiles. Characters, inventory, and progress are optional.</p><div className="grid-2"><Field label="Active profile"><select disabled={blocked || busy || profileBusy} onChange={(event) => void runProfileAction(() => onSelectProfile(event.target.value as ProfileSummary['id']))} value={profile.id}>{profiles.map((entry) => <option key={entry.id} value={entry.id}>{entry.label} · revision {entry.revision}</option>)}</select></Field><div className="field"><label className="field__label" htmlFor="new-profile-label">New blank profile</label><div className="cluster"><input disabled={blocked || busy || profileBusy} id="new-profile-label" onChange={(event) => setProfileLabel(event.target.value)} placeholder="Build collection or playthrough name" value={profileLabel}/><Button disabled={blocked || busy || profileBusy || !profileLabel.trim()} icon="plus" onClick={() => void runProfileAction(async () => { await onCreateProfile(profileLabel); setProfileLabel('') })} tone="secondary">Create</Button></div></div></div>{blocked && <InlineNotice title="Finish unsaved work before switching">Retry or export the current draft. Closing an edited ruleset form discards only those unsaved form fields.</InlineNotice>}</section>
      <section className="settings-section"><h3>Import or restore</h3><p className="settings-section__intro">Crystal Edit JSON, research files, and backups are parsed locally and previewed before saving.</p>{missingPreview && <InlineNotice title="Import preview expired" tone="warning">This address identifies a file preview that is no longer held in memory. Choose the source file again to create a fresh dry-run preview; no profile data was changed.</InlineNotice>}<ImportWorkspace busy={busy} disabled={blocked || profileBusy} importError={importError} key={JSON.stringify([profile.id, activePreview?.id ?? null])} onClear={clearPreview} onCommit={onCommit} onPreview={onPreview} preview={activePreview} profile={profile}/></section>
      <section className="settings-section"><div className="split"><div><h3>Reference corrections</h3><p className="settings-section__intro">Review and export your reference edits separately from personal playthrough records.</p></div><CorrectionsButton/></div></section>
      <section className="settings-section"><div className="split"><div><h3>Complete profile backup</h3><p className="settings-section__intro">Includes saved records, reference correction history, and any retained failed-save transaction. Submit open form fields first.</p></div><Button disabled={busy || profileBusy} icon="download" onClick={() => void exportBackupNow()} tone="secondary">Export backup</Button></div></section>
    </div>}
    {section === 'ruleset' && <>{panelError && <InlineNotice title="Unsaved ruleset fields" tone="warning">{panelError}</InlineNotice>}{requestedRulesetId && !requestedRuleset && <InlineNotice title="Requested ruleset unavailable" tone="warning">The pinned ruleset could not be opened. The active ruleset is shown instead.</InlineNotice>}<RulesetForm focus={focus} key={`${profile.id}:${requestedRuleset?.id ?? profile.activeRulesetRevisionId ?? 'new'}:${focus ?? 'top'}`} onDirty={setRulesetDirty} onSubmit={onSaveRuleset} profile={profile} saveError={dirty ? saveError : undefined} sourceRulesetRevisionId={requestedRuleset?.id}/></>}
    {section === 'history' && <div className="stack"><section className="settings-section"><div className="split"><div><h3>Undo latest saved change</h3><p className="settings-section__intro">Undo creates another local revision and keeps the journal auditable.</p></div><Button disabled={blocked || busy || profileBusy || !canUndo || !undoConfirmed} icon="history" onClick={() => void runProfileAction(async () => { await onUndo(); setUndoConfirmed(false) })} tone="secondary">Undo latest</Button></div><label className="check-row"><input checked={undoConfirmed} disabled={blocked || busy || profileBusy || !canUndo} onChange={(event) => setUndoConfirmed(event.target.checked)} type="checkbox"/><span><strong>Restore the previous saved profile state</strong><small>{canUndo ? 'The restored state is recorded as a new revision' : 'No retained local checkpoint is available for this revision'}</small></span></label></section>{profile.changes.length ? <ol className="history-list">{[...profile.changes].reverse().slice(0, 100).map((entry) => <li className="history-entry" key={entry.id}><span className="history-entry__mark"><Icon name="history"/></span><div><strong>{entry.command}</strong><p>{entry.changedPaths.slice(0, 3).join(', ')}{entry.changedPaths.length > 3 ? ` and ${entry.changedPaths.length - 3} more` : ''}</p><time>{formatRelativeDate(entry.recordedAt)} · revision {entry.nextRevision}</time></div></li>)}</ol> : <InlineNotice title="No change history">Commands appear here after the first successful local transaction.</InlineNotice>}{profile.changes.length > 100 && <InlineNotice title="Earlier changes not shown">Export the profile to preserve and inspect the complete bounded journal.</InlineNotice>}</div>}
    {section === 'storage' && <StorageSection dirty={blocked} onExport={onExport} profile={profile} saveError={saveError}/>}
    {section === 'credits' && <CreditsSection/>}
  </Sheet>
}
