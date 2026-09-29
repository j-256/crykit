import { equipmentRole, EQUIPMENT_ROLE_LABELS } from '../domain/mechanics-facts'
import { requirePlaythrough } from '../domain'
import type { EquipmentRole } from '../domain/types'
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import type { CatalogEntityKind, Knowledge, LocalData, PlaythroughId, GameSetupRevisionId, SlotDefinition, SlotId, SlotProvenance, SourceRef } from '../domain/types'
import { DEFAULT_GAME_VERSION, DEFAULT_PP_COSTS_NONNEGATIVE, DEFAULT_PP_LIMIT } from '../domain/local-data'
import { SUGGESTED_BUILD_SLOTS } from '../domain/build-planning'
import { modState, normalizeModName, recordedModNames, updateModSelections, type ModConfiguration, type ModSelection } from '../domain/mods'
import { CONFIRMED_SWITCH_MOD_SETUP, SWITCH_MOD_PACKS } from '../catalog/mods'
import { AppDataError, MAX_IMPORT_BYTES } from '../interchange'
import type { ImportCommitMode, ImportPreview } from '../interchange/types'
import { activateOfflineUpdate, getOfflineStatus, requestOfflineReadiness, requestPersistentStorage, subscribeOfflineStatus, type OfflineStatus } from '../offline'
import { Badge, Button, DefinitionRow, Field, InlineNotice, Spinner } from './components'
import { Icon } from './icons'
import { activeGameSetup, downloadBytes, formatAppError, formatRelativeDate, ownRecordValue } from './model'
import { useNavigation, useNavigationBlocker, type SettingsSection } from './navigation'
import { CorrectionsButton } from './Corrections'
import { Sheet } from './Sheet'
import { CreditsSection } from './CreditsSection'

const IMPORT_WARNING_PRIMARY_COUNT = 8
const IMPORT_WARNING_DOM_LIMIT = 100
const GAME_SETUP_PLATFORM = Object.freeze({ SWITCH: 'Nintendo Switch', PC: 'PC' })
const GAME_SETUP_PLATFORM_OPTIONS = Object.freeze([
  { value: GAME_SETUP_PLATFORM.SWITCH, label: 'Nintendo Switch' },
  { value: GAME_SETUP_PLATFORM.PC, label: 'PC (Windows, macOS, or Linux)' },
])
const GAME_SETUP_VERSION_OPTIONS_BY_PLATFORM: Readonly<Record<string, readonly { readonly value: string; readonly label: string }[]>> = Object.freeze({
  [GAME_SETUP_PLATFORM.SWITCH]: Object.freeze([
    { value: '< 1.6.6', label: '< 1.6.6' },
    { value: DEFAULT_GAME_VERSION, label: DEFAULT_GAME_VERSION },
    { value: '> 1.6.6', label: '> 1.6.6' },
  ]),
  [GAME_SETUP_PLATFORM.PC]: Object.freeze([
    { value: '< 1.6.6', label: '< 1.6.6' },
    { value: DEFAULT_GAME_VERSION, label: DEFAULT_GAME_VERSION },
    { value: '> 1.6.6', label: '> 1.6.6' },
  ]),
})
const GAME_SETUP_MODE_OPTIONS = Object.freeze([
  { value: 'Standard', label: 'Standard' },
  { value: 'Vanilla', label: 'Vanilla' },
  { value: 'Chaos', label: 'Chaos' },
])
const STEAM_WORKSHOP_URL = 'https://steamcommunity.com/app/1637730/workshop/'
const NINTENDO_MOD_PACK_1_URL = 'https://www.nintendo.com/us/store/products/mod-pack-1-quality-fun-70050000048696-switch/'
const NINTENDO_MOD_PACK_2_URL = 'https://www.nintendo.com/us/store/products/mod-pack-2-new-challenges-70050000051088-switch/'

export interface GameSetupDraft {
  readonly sourceGameSetupRevisionId?: GameSetupRevisionId
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
function ImportPanel({ preview, importError, busy, disabled, onPreview, onCommit, onClear }: { preview?: ImportPreview; importError?: string; busy: boolean; disabled: boolean; onPreview: (bytes: Uint8Array, filename: string) => Promise<void>; onCommit: (preview: ImportPreview, mode: ImportCommitMode, restoreCorrections?: boolean) => Promise<void>; onClear: () => void }) {
  const [mode, setMode] = useState<ImportCommitMode>(preview?.detectedFormat === 'crystal-edit-json-1' ? 'add-reference' : 'replace')
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
    return <div className="import-preview">{(importError || readError) && <InlineNotice title="Data operation could not be completed" tone="danger">{importError ?? readError} The preview and current planner data remain available.</InlineNotice>}<div className="split"><div><p className="eyebrow">Import preview</p><h3>{preview.filename}</h3></div><Button onClick={() => { setMode('replace'); setReplaceConfirmed(false); setReadError(undefined); onClear() }} tone="quiet">Choose another file</Button></div><dl className="definition-list"><DefinitionRow term="Detected format">{preview.detectedFormat}</DefinitionRow><DefinitionRow term="Schema">{preview.detectedSchema}</DefinitionRow><DefinitionRow term="Suggested Playthrough label">{preview.localData.label}</DefinitionRow><DefinitionRow term="Data identity">{preview.localData.identity ?? 'No source identity'}</DefinitionRow></dl><div className="import-preview__counts"><div className="metric"><span className="metric__label">Reference records</span><span className="metric__value">{preview.counts.reference}</span><span className="metric__detail">Definitions and claims</span></div><div className="metric"><span className="metric__label">Personal records</span><span className="metric__value">{preview.counts.personal}</span><span className="metric__detail">Observations and plans</span></div></div>{preview.errors.map((problem) => <InlineNotice key={`${problem.code}:${problem.locator}`} title={problem.code} tone="danger">{problem.message}</InlineNotice>)}{primaryWarnings.map((problem) => <InlineNotice key={`${problem.code}:${problem.locator}`} title={problem.code} tone="warning">{problem.message}</InlineNotice>)}{additionalWarnings.length > 0 && <details><summary>{additionalWarnings.length} more warnings</summary><div className="stack">{additionalWarnings.map((problem) => <p key={`${problem.code}:${problem.locator}`}>{problem.message}</p>)}</div></details>}{omittedWarnings > 0 && <InlineNotice title="Additional warnings omitted" tone="warning">{omittedWarnings.toLocaleString()} additional warnings are not rendered in this preview.</InlineNotice>}<details><summary>Source and coverage details</summary><dl className="definition-list"><DefinitionRow term="Source digest">{preview.sourceDigest}</DefinitionRow><DefinitionRow term="Catalog snapshots">{preview.proposed.catalogs.length}</DefinitionRow><DefinitionRow term="Evidence records">{preview.proposed.evidence.length}</DefinitionRow><DefinitionRow term="Ignored rows">{preview.counts.ignored}</DefinitionRow></dl></details><Field hint={mode === 'add-reference' ? 'Adds this catalog and its source file. Playthroughs, Builds, and Game Setups stay intact.' : 'Replaces all local planner data only after a successful transaction.'} label="Import action"><select onChange={(event) => { setMode(event.target.value as ImportCommitMode); setReplaceConfirmed(false) }} value={mode}>{preview.detectedFormat === 'crystal-edit-json-1' && <option value="add-reference">Add references to the shared library</option>}<option value="replace">Replace all planner data</option></select></Field>{mode === 'replace' && <label className="check-row"><input checked={replaceConfirmed} onChange={(event) => setReplaceConfirmed(event.target.checked)} type="checkbox"/><span><strong>Replace all local planner data after validation</strong><small>Existing data stays unchanged if the transaction fails</small></span></label>}{preview.proposed.corrections?.entries.length ? <label className="check-row"><input checked={restoreCorrections} onChange={event => setRestoreCorrections(event.target.checked)} type="checkbox"/><span>Restore reference corrections from this backup<small>Competing corrections stay pending for an explicit choice.</small></span></label> : null}<Button disabled={busy || disabled || preview.errors.length > 0 || (mode === 'replace' && !replaceConfirmed)} icon="check" onClick={() => void onCommit(preview, mode, restoreCorrections)}>{busy ? 'Importing...' : mode === 'add-reference' ? 'Add references' : 'Replace planner data'}</Button></div>
  }
  return <div className="stack">{(importError || readError) && <InlineNotice title="Data operation could not be completed" tone="danger">{importError ?? readError} Your existing planner data has not been replaced.</InlineNotice>}<button className="import-zone" disabled={busy || disabled} onClick={() => inputRef.current?.click()} type="button">{busy ? <Spinner label="Reading import"/> : <><Icon name="upload"/><span><strong>Choose a JSON, ZIP, or workbook</strong><span>The file is validated and previewed before any write.</span></span></>}</button><input accept=".json,.zip,.xlsx,application/json,application/zip,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" aria-label="Choose import file" className="sr-only" onChange={(event) => void choose(event)} ref={inputRef} type="file"/><InlineNotice title="Private local import">Imported personal records and evidence stay in this browser. No file is uploaded.</InlineNotice></div>
}

const GAME_SETUP_ENTITY_KINDS: readonly CatalogEntityKind[] = ['item', 'class', 'ability', 'passive', 'innate', 'monsterMagic', 'monster', 'status', 'command', 'recipe', 'location', 'other']
const GAME_SETUP_ENTITY_KIND_LABELS: Readonly<Record<CatalogEntityKind, string>> = Object.freeze({ item: 'Item', class: 'Class', ability: 'Ability', passive: 'Passive', innate: 'Innate', monsterMagic: 'Monster Magic', monster: 'Monster', status: 'Status', command: 'Command', recipe: 'Recipe', location: 'Location', other: 'Other' })
const SWITCH_MOD_NAMES = new Set(SWITCH_MOD_PACKS.flatMap(pack => pack.mods.map(normalizeModName)))

type GameSetupFocus = 'setup' | 'passives' | 'slots'

interface EditableGameSetupSlot {
  readonly id?: SlotId
  readonly label: string
  readonly equipmentRole?: EquipmentRole | null
  readonly acceptedKinds: readonly CatalogEntityKind[]
  readonly acceptedKindsTouched: boolean
  readonly acceptedEntityKinds?: Knowledge<readonly CatalogEntityKind[]>
  readonly provenance: SlotProvenance
  readonly sources: readonly SourceRef[]
}

function editableSlot(slot: SlotDefinition): EditableGameSetupSlot {
  return { id: slot.id, label: slot.label, equipmentRole: slot.equipmentRole === null ? null : equipmentRole(slot), acceptedKinds: slot.acceptedEntityKinds?.state === 'known' ? slot.acceptedEntityKinds.value : [], acceptedKindsTouched: false, acceptedEntityKinds: slot.acceptedEntityKinds, provenance: slot.provenance, sources: slot.sources }
}

function optionsWithRecordedValue(options: readonly { readonly value: string; readonly label: string }[], value: string): readonly { readonly value: string; readonly label: string }[] {
  return value && !options.some(option => option.value === value) ? [...options, { value, label: `${value} (imported)` }] : options
}

function userDefinedSlot(slot: EditableGameSetupSlot): EditableGameSetupSlot {
  return { ...slot, provenance: 'userDefined', sources: [] }
}

function GameSetupForm({ localData, sourceGameSetupRevisionId, focus, saveError, onSubmit, onDirty }: { localData: LocalData; sourceGameSetupRevisionId?: GameSetupRevisionId; focus?: GameSetupFocus; saveError?: string; onSubmit: (draft: GameSetupDraft) => Promise<void>; onDirty: (dirty: boolean) => void }) {
  const current = sourceGameSetupRevisionId ? ownRecordValue(localData.gameSetups, sourceGameSetupRevisionId) : activeGameSetup(localData)
  const [label, setLabel] = useState(current?.label ?? '')
  const [platform, setPlatform] = useState(current?.platform.state === 'known' ? current.platform.value : '')
  const [version, setVersion] = useState(current?.gameVersion.state === 'known' ? current.gameVersion.value : current ? '' : DEFAULT_GAME_VERSION)
  const [mode, setMode] = useState(current?.mode.state === 'known' ? current.mode.value : '')
  const [modConfiguration, setModConfiguration] = useState<ModConfiguration>({ mods: current?.mods ?? { state: 'unknown' }, disabledMods: current?.disabledMods })
  const [touched, setTouched] = useState({ platform: false, version: false, mode: false })
  const [ppLimit, setPpLimit] = useState<Knowledge<number>>(current?.ppLimit ?? { state: 'known', value: DEFAULT_PP_LIMIT })
  const [ppCostsNonNegative, setPpCostsNonNegative] = useState<Knowledge<boolean>>(current?.ppCostsNonNegative ?? { state: 'known', value: DEFAULT_PP_COSTS_NONNEGATIVE })
  const [slots, setSlots] = useState<EditableGameSetupSlot[]>(current?.slots.map(editableSlot) ?? [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const setupRef = useRef<HTMLDetailsElement>(null)
  const passivesRef = useRef<HTMLDetailsElement>(null)
  const advancedRef = useRef<HTMLDetailsElement>(null)
  const slotsRef = useRef<HTMLDetailsElement>(null)
  const stringKnowledge = (value: string): Knowledge<string> => value.trim() ? { state: 'known', value: value.trim() } : { state: 'unknown' }
  const preservedHint = (value: Knowledge<unknown> | undefined) => value?.state === 'conflicting' ? 'Conflicting imported claims are preserved until you edit this field.' : value?.state === 'notApplicable' ? 'The imported not-applicable state is preserved until you edit this field.' : undefined
  useEffect(() => {
    if (!focus) return
    const frame = window.requestAnimationFrame(() => {
      const target = focus === 'setup' ? setupRef.current : focus === 'passives' ? passivesRef.current : slotsRef.current
      if (advancedRef.current) advancedRef.current.open = true
      if (target) target.open = true
      target?.scrollIntoView({ block: 'start' })
      target?.querySelector<HTMLElement>('input, select, button')?.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [focus])
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError(undefined)
    if (ppLimit.state !== 'known') {
      if (advancedRef.current) advancedRef.current.open = true
      if (passivesRef.current) passivesRef.current.open = true
      setError('Enter the total passive PP budget before saving this Game Setup.')
      return
    }
    setBusy(true)
    try {
      await onSubmit({
        sourceGameSetupRevisionId: current?.id,
        label,
        platform: touched.platform ? stringKnowledge(platform) : current?.platform ?? { state: 'unknown' },
        gameVersion: touched.version ? stringKnowledge(version) : current?.gameVersion ?? { state: 'unknown' },
        mode: touched.mode ? stringKnowledge(mode) : current?.mode ?? { state: 'unknown' },
        ...modConfiguration,
        ppLimit,
        ppCostsNonNegative,
        slots: slots.filter(slot => slot.label.trim()).map(slot => ({ id: slot.id, label: slot.label, equipmentRole: slot.equipmentRole, acceptedEntityKinds: slot.acceptedKindsTouched ? slot.acceptedKinds.length ? { state: 'known', value: slot.acceptedKinds } : { state: 'unknown' } : slot.acceptedEntityKinds, provenance: slot.provenance, sources: slot.sources })),
      })
      onDirty(false)
    } catch (reason) {
      setError(formatAppError(reason, 'The Game Setup revision could not be saved.'))
    } finally {
      setBusy(false)
    }
  }
  const addSlot = () => setSlots((values) => [...values, { label: '', acceptedKinds: ['item'], acceptedKindsTouched: true, provenance: 'userDefined', sources: [] }])
  const acceptPlannerLayout = () => {
    setSlots(values => (values.length ? values : SUGGESTED_BUILD_SLOTS.map(editableSlot)).map(slot => slot.provenance === 'suggested' ? userDefinedSlot(slot) : slot))
    onDirty(true)
  }
  const useConfirmedModSetup = () => {
    setPlatform(CONFIRMED_SWITCH_MOD_SETUP.platform)
    setVersion(DEFAULT_GAME_VERSION)
    setModConfiguration(value => updateModSelections(value, [
      ...CONFIRMED_SWITCH_MOD_SETUP.enabledMods.map(name => ({ name, state: 'enabled' as const })),
      ...CONFIRMED_SWITCH_MOD_SETUP.disabledMods.map(name => ({ name, state: 'disabled' as const })),
    ]))
    setTouched(value => ({ ...value, platform: true, version: true }))
    onDirty(true)
  }
  const otherMods = recordedModNames(modConfiguration).filter(name => !SWITCH_MOD_NAMES.has(normalizeModName(name)))
  const hasSuggestedSlots = slots.some(slot => slot.provenance === 'suggested')
  const ppValue = ppCostsNonNegative.state === 'known' ? String(ppCostsNonNegative.value) : ppCostsNonNegative.state
  const switchModStates = SWITCH_MOD_PACKS.flatMap(pack => pack.mods.map(name => modState(modConfiguration, name)))
  const enabledModCount = switchModStates.filter(state => state === 'enabled').length
  const unresolvedModCount = switchModStates.filter(state => state === 'unknown' || state === 'conflicting').length
  const setupRecordedCount = [platform, version, mode].filter(value => value.trim()).length
  const platformOptions = optionsWithRecordedValue(GAME_SETUP_PLATFORM_OPTIONS, platform)
  const modeOptions = optionsWithRecordedValue(GAME_SETUP_MODE_OPTIONS, mode)
  const versionOptions = optionsWithRecordedValue(GAME_SETUP_VERSION_OPTIONS_BY_PLATFORM[platform] ?? GAME_SETUP_VERSION_OPTIONS_BY_PLATFORM[GAME_SETUP_PLATFORM.SWITCH]!, version)
  const versionUnsetLabel = current?.gameVersion.state === 'conflicting' ? 'Conflicting claims (imported)' : current?.gameVersion.state === 'notApplicable' ? 'Not applicable (imported)' : 'Not set (imported)'
  return <form className="stack" onInput={() => onDirty(true)} onSubmit={submit}>
    <div className="game-setup-intro"><div><p className="eyebrow">Game Setup snapshot</p><h2>{current ? `${current.label} · revision ${current.revision}` : 'New Game Setup'}</h2><p>Record the mods used by this save. Technical setup and validation fields are available under Advanced Game Setup.</p></div><Badge tone="info">New revisions preserve saved pins</Badge></div>
    <Field label="Game Setup label" required><input onChange={(event) => setLabel(event.target.value)} placeholder="For example: Switch playthrough" required value={label}/></Field>
    <section aria-labelledby="game-setup-mods-heading" className="stack">
      <div className="split game-setup-mod-heading"><div><h3 id="game-setup-mods-heading">Mods</h3><p className="settings-section__intro">Record each enabled or disabled mod independently for this save.</p></div><Badge tone={unresolvedModCount ? 'warning' : 'positive'}>{enabledModCount} of {switchModStates.length} enabled</Badge></div>
      <InlineNotice title="Starter list, not a complete catalog">The choices below cover the supplied Nintendo packs and selected Steam mods. Browse the source catalogs for anything else installed in your game.</InlineNotice>
      <div className="cluster"><a href={STEAM_WORKSHOP_URL} rel="noreferrer noopener" target="_blank">Steam Workshop</a><a href={NINTENDO_MOD_PACK_1_URL} rel="noreferrer noopener" target="_blank">Nintendo eShop: Mod Pack 1</a><a href={NINTENDO_MOD_PACK_2_URL} rel="noreferrer noopener" target="_blank">Nintendo eShop: Mod Pack 2</a></div>
      <div className="split"><p className="settings-section__intro">{unresolvedModCount ? `${unresolvedModCount} listed mods need review.` : 'Every listed mod has been reviewed.'}</p><Button onClick={useConfirmedModSetup} tone="secondary" type="button">Apply Nintendo eShop defaults</Button></div>
      <div className="grid-2 game-setup-mod-packs">{SWITCH_MOD_PACKS.map(pack => { const packStates = pack.mods.map(name => modState(modConfiguration, name)); const packEnabled = packStates.filter(state => state === 'enabled').length; const packUnresolved = packStates.filter(state => state === 'unknown' || state === 'conflicting').length; return <details className="game-setup-mod-pack" key={pack.id}><summary><span><strong>{pack.name}</strong><small>{packEnabled} of {pack.mods.length} enabled · {packUnresolved} need review</small></span><Badge tone={packUnresolved ? 'warning' : 'positive'}>{packUnresolved ? 'Review' : 'Done'}</Badge></summary><div className="game-setup-mod-pack__body">{pack.mods.map(name => { const state = modState(modConfiguration, name); return <label className="game-setup-mod-choice" key={name}><span>{name}</span><select aria-label={name} data-mod-state={state} onChange={event => { setModConfiguration(value => updateModSelections(value, [{ name, state: event.target.value as ModSelection['state'] }])); onDirty(true) }} value={state}><option value="unknown">Unknown</option><option value="enabled">Enabled</option><option value="disabled">Disabled</option>{state === 'conflicting' && <option disabled value="conflicting">Conflicting</option>}</select></label> })}</div></details> })}</div>
      {otherMods.length > 0 && <details><summary>Other imported mod names (preserved)</summary><p className="settings-section__intro">These names are outside the supplied starter list. Their recorded states are retained when you change listed mods.</p><dl className="definition-list">{otherMods.map(name => <DefinitionRow key={name} term={name}>{modState(modConfiguration, name)}</DefinitionRow>)}</dl></details>}
    </section>
    <details className="game-setup-advanced" ref={advancedRef}>
      <summary><span><strong>Advanced Game Setup</strong><small>Platform, version, mode, validation rules, and equipment schema</small></span><Icon name="chevron-down"/></summary>
      <div className="game-setup-advanced__body stack">
        <InlineNotice title="Most playthroughs only need the mod list">These settings drive compatibility and validation. Imported unresolved values remain intact until you edit them.</InlineNotice>
        <details className="game-setup-editor-section" data-game-setup-focus="setup" id="game-setup-setup-section" ref={setupRef}><summary><span className="game-setup-editor-section__icon"><Icon name="settings"/></span><span><strong>Game context</strong><small>Platform, version, and mode</small></span><Badge tone={setupRecordedCount === 3 ? 'positive' : 'warning'}>{setupRecordedCount} of 3 recorded</Badge></summary><div className="game-setup-editor-section__body"><div className="grid-3 game-setup-fields"><Field hint={preservedHint(current?.platform)} label="Platform"><select aria-label="Platform" onChange={(event) => { setPlatform(event.target.value); setTouched((value) => ({ ...value, platform: true })) }} value={platform}><option value="">Not set</option>{platformOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></Field><Field hint={preservedHint(current?.gameVersion) ?? 'Choose the matching version range shown in game.'} label="Game version"><select aria-label="Game version" onChange={(event) => { setVersion(event.target.value); setTouched((state) => ({ ...state, version: true })) }} value={version}>{version === '' && <option disabled value="">{versionUnsetLabel}</option>}{versionOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></Field><Field hint={preservedHint(current?.mode)} label="Game mode"><select aria-label="Game mode" onChange={(event) => { setMode(event.target.value); setTouched((value) => ({ ...value, mode: true })) }} value={mode}><option value="">Not set</option>{modeOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></Field></div></div></details>
        <details className="game-setup-editor-section" data-game-setup-focus="passives" id="game-setup-passives-section" ref={passivesRef}><summary><span className="game-setup-editor-section__icon"><Icon name="spark"/></span><span><strong>Passive validation rules</strong><small>Total PP limit and cost assumptions</small></span><Badge tone={ppLimit.state === 'known' && ppCostsNonNegative.state === 'known' ? 'positive' : 'warning'}>{ppLimit.state === 'known' ? `<= ${ppLimit.value} PP` : 'Review'}</Badge></summary><div className="game-setup-editor-section__body grid-2"><div className="field"><span className="field__label">Passive PP limit</span>{ppLimit.state !== 'known' && <InlineNotice title="Confirm the PP limit" tone="warning">This imported Game Setup does not establish a PP limit. The unmodified game uses 10; enter a different value only when a mod changes it.</InlineNotice>}<input aria-label="Build PP limit" min="0" onChange={(event) => setPpLimit(event.target.value === '' ? { state: 'unknown' } : { state: 'known', value: Number(event.target.value) })} placeholder="Enter PP limit" required step="1" type="number" value={ppLimit.state === 'known' ? ppLimit.value : ''}/><span className="field__hint">The unmodified game uses 10 PP across all equipped passives.</span></div><Field hint="Individual passive costs spend PP; they do not refund points. This assumption supports validation when another cost is unresolved." label="Individual PP costs"><select onChange={(event) => setPpCostsNonNegative(event.target.value === 'true' ? { state: 'known', value: true } : event.target.value === 'false' ? { state: 'known', value: false } : { state: 'unknown' })} value={ppValue}><option value="true">Cannot be negative</option><option value="false">Negative values permitted</option><option value="unknown">Not confirmed</option>{ppCostsNonNegative.state === 'conflicting' && <option disabled value="conflicting">Conflicting imported claims</option>}{ppCostsNonNegative.state === 'notApplicable' && <option disabled value="notApplicable">Not applicable</option>}</select></Field></div></details>
        <details className="game-setup-editor-section" data-game-setup-focus="slots" id="game-setup-slots-section" ref={slotsRef}><summary><span className="game-setup-editor-section__icon"><Icon name="shield"/></span><span><strong>Equipment slot rules</strong><small>Slot names, order, roles, and accepted definition types</small></span><Badge tone={hasSuggestedSlots || slots.length === 0 ? 'warning' : 'positive'}>{hasSuggestedSlots || slots.length === 0 ? 'Review' : `${slots.length} saved`}</Badge></summary><div className="game-setup-editor-section__body stack"><div className="split"><p className="settings-section__intro">These rules define the equipment fields available to Builds and character snapshots.</p><div className="cluster">{(hasSuggestedSlots || slots.length === 0) && <Button onClick={acceptPlannerLayout} tone="secondary" type="button">{slots.length ? 'Apply planner defaults' : 'Use planner defaults'}</Button>}<Button icon="plus" onClick={addSlot} tone="secondary" type="button">Add equipment slot</Button></div></div>{hasSuggestedSlots && <InlineNotice title="Planner defaults need review">Review the displayed slots or apply the defaults for this revision. Applying them records your choice; it does not claim independent verification of game behavior.</InlineNotice>}{slots.length ? slots.map((slot, index) => <div className="grid-3 game-setup-fields" key={slot.id ?? index}><Field label={`Equipment slot ${index + 1}`}><input onChange={(event) => setSlots((values) => values.map((value, itemIndex) => itemIndex === index ? userDefinedSlot({ ...value, label: event.target.value }) : value))} placeholder="Main hand" value={slot.label}/></Field><Field label="Equipment role"><select aria-label={`Slot ${index + 1} equipment role`} onChange={event => setSlots(values => values.map((value, itemIndex) => itemIndex === index ? userDefinedSlot({ ...value, equipmentRole: event.target.value as EquipmentRole || null }) : value))} value={slot.equipmentRole ?? ''}><option value="">Unspecified</option>{Object.entries(EQUIPMENT_ROLE_LABELS).map(([role, slotLabel]) => <option key={role} value={role}>{slotLabel}</option>)}</select></Field><Field hint={slot.acceptedEntityKinds?.state === 'conflicting' && !slot.acceptedKindsTouched ? 'Conflicting imported claims are preserved until edited.' : 'Choose one or more definition types, normally Item.'} label="Accepted types"><select aria-label="Accepted types" multiple onChange={(event) => { const acceptedKinds = [...event.target.selectedOptions].map(option => option.value as CatalogEntityKind); setSlots((values) => values.map((value, itemIndex) => itemIndex === index ? userDefinedSlot({ ...value, acceptedKinds, acceptedKindsTouched: true }) : value)) }} size={4} value={[...slot.acceptedKinds]}>{GAME_SETUP_ENTITY_KINDS.map(kind => <option key={kind} value={kind}>{GAME_SETUP_ENTITY_KIND_LABELS[kind]}</option>)}</select></Field></div>) : <InlineNotice title="No equipment slots configured">Add only the ordered equipment slots established for this game configuration.</InlineNotice>}</div></details>
      </div>
    </details>
    {(error || saveError) && <InlineNotice title="Game Setup not saved" tone="danger">{error ?? saveError} Your configuration remains in this form.{saveError && ' Close this panel and use Retry save to keep the retained revision.'}</InlineNotice>}
    <div className="form-actions game-setup-save-bar"><span>Saving creates a new active revision. Existing builds and teams keep their saved Game Setup.</span><Button disabled={busy || !label.trim()} icon="check" type="submit">{busy ? 'Saving...' : current ? 'Save new Game Setup revision' : 'Create Game Setup'}</Button></div>
  </form>
}

function StorageSection({ localData, dirty, saveError, onExport }: { localData: LocalData; dirty: boolean; saveError?: string; onExport: () => Promise<Uint8Array> }) {
  const [offline, setOffline] = useState<OfflineStatus>({ state: 'checking' })
  const [busy, setBusy] = useState(false)
  const [persisted, setPersisted] = useState<boolean>()
  const [exportError, setExportError] = useState<string>()
  const [storageError, setStorageError] = useState<string>()
  useEffect(() => { const unsubscribe = subscribeOfflineStatus(setOffline); void getOfflineStatus().then(setOffline).catch(() => setStorageError('Offline readiness could not be inspected.')); return unsubscribe }, [])
  const prepareOffline = async () => { setBusy(true); setStorageError(undefined); try { setOffline(await requestOfflineReadiness()) } catch (reason) { setStorageError(formatAppError(reason, 'Offline preparation could not be completed.')) } finally { setBusy(false) } }
  const requestPersistence = async () => { setBusy(true); setStorageError(undefined); try { setPersisted(await requestPersistentStorage()) } catch (reason) { setStorageError(formatAppError(reason, 'Persistent storage could not be requested.')) } finally { setBusy(false) } }
  const applyUpdate = async () => { setBusy(true); setStorageError(undefined); try { await activateOfflineUpdate() } catch (reason) { setStorageError(formatAppError(reason, 'The application update could not be activated.')) } finally { setBusy(false) } }
  const exportNow = async () => { setBusy(true); setExportError(undefined); try { const label = requirePlaythrough(localData).label; downloadBytes(await onExport(), `crystal-companion-${label.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-') || 'playthrough'}.zip`, 'application/zip') } catch (error) { setExportError(formatAppError(error, 'The backup could not be prepared.')) } finally { setBusy(false) } }
  return <div className="stack">{saveError && <InlineNotice title="Local save failed" tone="danger">{saveError} The retained transaction is included in a recovery backup. Fields still only in an unsubmitted form are not included.</InlineNotice>}{dirty && <InlineNotice title="Unsaved changes" tone="warning">Save or submit open form fields before exporting. Backups include retained failed-save transactions, but not fields that still exist only in a form.</InlineNotice>}{storageError && <InlineNotice title="Storage operation failed" tone="danger">{storageError}</InlineNotice>}<section className="settings-section"><div className="split"><div><h3>Portable backup</h3><p className="settings-section__intro">Create an explicit file for recovery or transfer.</p></div><Button disabled={busy} icon="download" onClick={() => void exportNow()}>Export backup</Button></div>{exportError && <InlineNotice title="Export failed" tone="danger">{exportError}</InlineNotice>}</section><section className="settings-section"><div className="split"><div><h3>Offline application</h3><p className="settings-section__intro">{offline.detail ?? 'Checking cached application files...'}</p></div><Badge tone={offline.state === 'ready' ? 'positive' : offline.state === 'error' ? 'danger' : 'warning'}>{offline.state === 'ready' ? 'Offline ready' : offline.state === 'checking' ? 'Checking' : offline.state === 'unsupported' ? 'Unsupported' : offline.state === 'error' ? 'Unavailable' : 'Not ready'}</Badge></div>{offline.state !== 'ready' && offline.state !== 'unsupported' && <Button disabled={busy} icon="download" onClick={() => void prepareOffline()} tone="secondary">Prepare for offline use</Button>}{offline.updateAvailable && <Button disabled={dirty} onClick={() => void applyUpdate()} tone="secondary">{dirty ? 'Save or discard changes before updating' : 'Apply app update'}</Button>}</section><section className="settings-section"><div className="split"><div><h3>Browser storage</h3><p className="settings-section__intro">Persistent storage can reduce eviction risk but is not a backup.</p></div>{persisted !== undefined && <Badge tone={persisted ? 'positive' : 'warning'}>{persisted ? 'Persistence granted' : 'Request not granted'}</Badge>}</div><Button disabled={busy} onClick={() => void requestPersistence()} tone="secondary">Request persistent storage</Button></section></div>
}

export function DataPanel({ open, localData, preview, importError, busy, canUndo, dirty, saveError, onClose, onPreview, onCommit, onClearPreview, onExport, onSaveGameSetup, onCreatePlaythrough, onSelectPlaythrough, onUndo }: { open: boolean; localData: LocalData; preview?: ImportPreview; importError?: string; busy: boolean; canUndo: boolean; dirty: boolean; saveError?: string; onClose: () => void; onPreview: (bytes: Uint8Array, filename: string) => Promise<void>; onCommit: (preview: ImportPreview, mode: ImportCommitMode, restoreCorrections?: boolean) => Promise<void>; onClearPreview: () => void; onExport: () => Promise<Uint8Array>; onSaveGameSetup: (draft: GameSetupDraft) => Promise<void>; onCreatePlaythrough: (label: string) => Promise<void>; onSelectPlaythrough: (playthroughId: PlaythroughId) => Promise<void>; onUndo: () => Promise<void> }) {
  const navigation = useNavigation()
  const settingsPage = navigation.route.page.page === 'settings' ? navigation.route.page : undefined
  const section = settingsPage?.section ?? 'data'
  const requestedPreviewId = settingsPage && 'previewId' in settingsPage ? settingsPage.previewId : undefined
  const activePreview = requestedPreviewId !== undefined && preview?.id === requestedPreviewId ? preview : undefined
  const missingPreview = requestedPreviewId !== undefined && !activePreview
  const requestedGameSetupId = navigation.route.query.gameSetup?.[0]
  const requestedGameSetup = requestedGameSetupId ? ownRecordValue(localData.gameSetups, requestedGameSetupId) : undefined
  const gameSetupFocus = navigation.route.query.focus?.[0]
  const focus = gameSetupFocus === 'setup' || gameSetupFocus === 'passives' || gameSetupFocus === 'slots' ? gameSetupFocus : undefined
  const [panelError, setPanelError] = useState<string>()
  const [panelDirty, setPanelDirty] = useState(false)
  const panelDirtyRef = useRef(false)
  const [playthroughLabel, setPlaythroughLabel] = useState('')
  const [dataBusy, setDataBusy] = useState(false)
  const [undoConfirmed, setUndoConfirmed] = useState(false)
  const blocked = dirty || panelDirty
  const setGameSetupDirty = (value: boolean) => { panelDirtyRef.current = value; setPanelDirty(value) }
  useNavigationBlocker({ page: { page: 'settings', section: 'game-setup' }, overlays: [], query: {} }, () => panelDirtyRef.current, () => setPanelError('Save the Game Setup revision or close this panel to discard its edited fields.'))
  const changeSection = (next: SettingsSection) => {
    if (panelDirty && next !== section) {
      setPanelError('Save the Game Setup revision or close this panel to discard its edited fields.')
      return
    }
    setPanelError(undefined)
    navigation.navigate({ page: { page: 'settings', section: next }, overlays: [], query: {} })
  }
  const exportBackupNow = async () => {
    setPanelError(undefined)
    try { downloadBytes(await onExport(), 'crystal-companion-backup.zip', 'application/zip') } catch (reason) { setPanelError(formatAppError(reason, 'The backup could not be prepared.')) }
  }
  const runDataAction = async (action: () => Promise<void>) => {
    setDataBusy(true)
    setPanelError(undefined)
    try { await action() } catch (reason) { setPanelError(formatAppError(reason, 'The Playthrough operation could not be completed.')) } finally { setDataBusy(false) }
  }
  const close = () => {
    setGameSetupDirty(false)
    setPanelError(undefined)
    setUndoConfirmed(false)
    onClose()
  }
  const clearPreview = () => {
    onClearPreview()
  }
  const playthrough = requirePlaythrough(localData)
  const playthroughs = Object.values(localData.playthroughs).sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id))
  return <Sheet description="Import, backup, Game Setups, history, and browser storage controls." onClose={close} open={open} title="Data & settings" width="wide">
    <div className="data-nav" role="group" aria-label="Data and settings sections">{([{ id: 'data', label: 'Import & backup' }, { id: 'game-setup', label: 'Game Setup' }, { id: 'history', label: 'History' }, { id: 'storage', label: 'Offline & storage' }, { id: 'credits', label: 'Credits & licenses' }] as const).map((item) => <button aria-pressed={section === item.id} key={item.id} onClick={() => changeSection(item.id)} type="button">{item.label}</button>)}</div>
    {panelError && section !== 'game-setup' && <InlineNotice title="Data operation could not be completed" tone="danger">{panelError}</InlineNotice>}
    {section === 'data' && <div className="stack">
      <section className="settings-section"><h3>Playthroughs</h3><p className="settings-section__intro">Each Playthrough is one save lineage with its own characters, inventory, progress, and teams. Game Setups and Builds are shared across Playthroughs.</p><div className="grid-2"><Field label="Active Playthrough"><select disabled={blocked || busy || dataBusy} onChange={(event) => void runDataAction(() => onSelectPlaythrough(event.target.value as PlaythroughId))} value={playthrough.id}>{playthroughs.map((entry) => <option key={entry.id} value={entry.id}>{entry.label} · revision {entry.revision}</option>)}</select></Field><div className="field"><label className="field__label" htmlFor="new-playthrough-label">New blank Playthrough</label><div className="cluster"><input disabled={blocked || busy || dataBusy} id="new-playthrough-label" onChange={(event) => setPlaythroughLabel(event.target.value)} placeholder="Playthrough name" value={playthroughLabel}/><Button disabled={blocked || busy || dataBusy || !playthroughLabel.trim()} icon="plus" onClick={() => void runDataAction(async () => { await onCreatePlaythrough(playthroughLabel); setPlaythroughLabel('') })} tone="secondary">Create</Button></div></div></div>{blocked && <InlineNotice title="Finish unsaved work before switching">Retry or export the current draft. Closing an edited Game Setup form discards only those unsaved form fields.</InlineNotice>}</section>
      <section className="settings-section"><h3>Import or restore</h3><p className="settings-section__intro">Crystal Edit JSON, research files, and backups are parsed locally and previewed before saving.</p>{missingPreview && <InlineNotice title="Import preview expired" tone="warning">This address identifies a file preview that is no longer held in memory. Choose the source file again to create a fresh dry-run preview; no planner data was changed.</InlineNotice>}<ImportPanel busy={busy} disabled={blocked || dataBusy} importError={importError} key={JSON.stringify([localData.id, activePreview?.id ?? null])} onClear={clearPreview} onCommit={onCommit} onPreview={onPreview} preview={activePreview}/></section>
      <section className="settings-section"><div className="split"><div><h3>Reference corrections</h3><p className="settings-section__intro">Review and export your reference edits separately from personal playthrough records.</p></div><CorrectionsButton/></div></section>
      <section className="settings-section"><div className="split"><div><h3>Complete planner backup</h3><p className="settings-section__intro">Includes all Playthroughs, Game Setups, Builds, saved records, reference correction history, and any retained failed-save transaction. Submit open form fields first.</p></div><Button disabled={busy || dataBusy} icon="download" onClick={() => void exportBackupNow()} tone="secondary">Export backup</Button></div></section>
    </div>}
    {section === 'game-setup' && <>{panelError && <InlineNotice title="Unsaved Game Setup fields" tone="warning">{panelError}</InlineNotice>}{requestedGameSetupId && !requestedGameSetup && <InlineNotice title="Requested Game Setup unavailable" tone="warning">The pinned Game Setup could not be opened. The current Game Setup is shown instead.</InlineNotice>}<GameSetupForm focus={focus} key={`${localData.id}:${requestedGameSetup?.id ?? localData.planningGameSetupRevisionId ?? 'new'}:${focus ?? 'top'}`} onDirty={setGameSetupDirty} onSubmit={onSaveGameSetup} localData={localData} saveError={dirty ? saveError : undefined} sourceGameSetupRevisionId={requestedGameSetup?.id}/></>}
    {section === 'history' && <div className="stack"><section className="settings-section"><div className="split"><div><h3>Undo latest saved change</h3><p className="settings-section__intro">Undo creates another local revision and keeps the journal auditable.</p></div><Button disabled={blocked || busy || dataBusy || !canUndo || !undoConfirmed} icon="history" onClick={() => void runDataAction(async () => { await onUndo(); setUndoConfirmed(false) })} tone="secondary">Undo latest</Button></div><label className="check-row"><input checked={undoConfirmed} disabled={blocked || busy || dataBusy || !canUndo} onChange={(event) => setUndoConfirmed(event.target.checked)} type="checkbox"/><span><strong>Restore the previous saved planner state</strong><small>{canUndo ? 'The restored state is recorded as a new revision' : 'No retained local checkpoint is available for this revision'}</small></span></label></section>{localData.changes.length ? <ol className="history-list">{[...localData.changes].reverse().slice(0, 100).map((entry) => <li className="history-entry" key={entry.id}><span className="history-entry__mark"><Icon name="history"/></span><div><strong>{entry.command}</strong><p>{entry.changedPaths.slice(0, 3).join(', ')}{entry.changedPaths.length > 3 ? ` and ${entry.changedPaths.length - 3} more` : ''}</p><time>{formatRelativeDate(entry.recordedAt)} · revision {entry.nextRevision}</time></div></li>)}</ol> : <InlineNotice title="No change history">Commands appear here after the first successful local transaction.</InlineNotice>}{localData.changes.length > 100 && <InlineNotice title="Earlier changes not shown">Export the planner data to preserve and inspect the complete bounded journal.</InlineNotice>}</div>}
    {section === 'storage' && <StorageSection dirty={blocked} onExport={onExport} localData={localData} saveError={saveError}/>}
    {section === 'credits' && <CreditsSection/>}
  </Sheet>
}
