import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { sameValue } from '../domain/definition-values'
import { definitionLineageRootRef } from '../domain/definitions'
import { DEFAULT_GAME_DIFFICULTY, DEFAULT_GAME_MODE, DEFAULT_GAME_VERSION, DEFAULT_PP_COSTS_NONNEGATIVE, DEFAULT_PP_LIMIT } from '../domain/local-data'
import { SUGGESTED_BUILD_SLOTS } from '../domain/build-planning'
import { PC_GAME_RULES, resolveGameRules } from '../domain/game-rules'
import { useDefinitionLibrary } from './definitions'
import { modState, normalizeModName, recordedModNames, updateModSelections } from '../domain/mods'
import type { BuildCalculationPlan, CatalogEntityKind, EquipmentRole, GameSetupRevision, GameSetupRevisionId, Knowledge, LocalData, ModComposition, PersonalRef, SlotId, SlotProvenance, SourceRef } from '../domain/types'
import { CONFIRMED_SWITCH_MOD_SETUP, SWITCH_MOD_PACKS } from '../catalog/mods'
import { NATIVE_GAME_DATA } from '../catalog/native-game'
import { Button, Field, InlineNotice } from './components'
import { Icon } from './icons'
import { formatAppError, knowledgeLabel } from './model'
import { ModLayersEditor } from './ModLayersEditor'
import { ModSelections } from './ModSelections'
import { GameRuleDetails } from './GameRuleDetails'
import './game-setup.css'

const PLATFORMS = ['Nintendo Switch', 'Windows', 'macOS', 'Linux', 'PC'] as const
const MODES = [DEFAULT_GAME_MODE, 'Vanilla', 'Chaos'] as const
const KNOWN_MODS = SWITCH_MOD_PACKS.flatMap(pack => pack.mods)

export interface GameSetupSaveOptions { readonly id: GameSetupRevisionId }

export type GameSetupFocus = 'setup' | 'passives' | 'slots'
export interface GameSetupDraft {
  readonly sourceGameSetupRevisionId?: GameSetupRevisionId
  readonly label: string
  readonly platform: Knowledge<string>
  readonly gameVersion: Knowledge<string>
  readonly mode: Knowledge<string>
  readonly difficulty?: GameSetupRevision['difficulty']
  readonly mods: Knowledge<readonly string[]>
  readonly disabledMods?: Knowledge<readonly string[]>
  readonly customMods?: readonly string[]
  readonly modComposition?: ModComposition
  readonly definitionOverrides?: readonly PersonalRef[]
  readonly ppLimit: Knowledge<number>
  readonly ppCostsNonNegative: Knowledge<boolean>
  readonly slots: readonly { readonly id?: SlotId; readonly label: string; readonly equipmentRole?: EquipmentRole | null; readonly acceptedEntityKinds?: Knowledge<readonly CatalogEntityKind[]>; readonly provenance: SlotProvenance; readonly sources: readonly SourceRef[] }[]
}

function initialDraft(current?: GameSetupRevision): GameSetupDraft {
  return {
    sourceGameSetupRevisionId: current?.id,
    label: current?.label ?? '',
    platform: current?.platform ?? { state: 'unknown' },
    gameVersion: current?.gameVersion ?? { state: 'unknown' },
    mode: current?.mode ?? { state: 'known', value: DEFAULT_GAME_MODE },
    difficulty: current ? current.difficulty : DEFAULT_GAME_DIFFICULTY,
    mods: current?.mods ?? { state: 'unknown' },
    disabledMods: current?.disabledMods,
    customMods: current?.customMods,
    modComposition: current?.modComposition,
    definitionOverrides: current?.definitionOverrides,
    ppLimit: current?.ppLimit ?? { state: 'known', value: DEFAULT_PP_LIMIT },
    ppCostsNonNegative: current?.ppCostsNonNegative ?? { state: 'known', value: DEFAULT_PP_COSTS_NONNEGATIVE },
    slots: current?.slots ?? SUGGESTED_BUILD_SLOTS,
  }
}

function textKnowledge(value: string): Knowledge<string> {
  return value.trim() ? { state: 'known', value: value.trim() } : { state: 'unknown' }
}

function preservedHint(value: Knowledge<unknown> | undefined): string | undefined {
  return value?.state === 'conflicting' ? 'Conflicting values are kept until you edit this field.' : value?.state === 'notApplicable' ? 'Kept as not applicable until you edit this field.' : undefined
}

function ContextChoice({ label, value, choices, onChange }: { label: string; value: Knowledge<string>; choices: readonly string[]; onChange: (value: Knowledge<string>) => void }) {
  const recorded = value.state === 'known' ? value.value : ''
  const selected = value.state === 'known' ? value.value : value.state === 'unknown' ? '' : value.state
  return <Field hint={preservedHint(value)} label={label}><select aria-label={label} onChange={event => onChange(textKnowledge(event.target.value))} value={selected}><option value="">Unknown</option>{value.state !== 'known' && value.state !== 'unknown' && <option disabled value={value.state}>{knowledgeLabel(value)}</option>}{[...new Set([...choices, ...(recorded ? [recorded] : [])])].map(choice => <option key={choice} value={choice}>{choice === 'PC' ? 'PC (platform unspecified)' : choice}</option>)}</select></Field>
}

export function gameSetupOverrideConflicts(localData: LocalData, draft: GameSetupDraft, current?: Pick<GameSetupRevision, 'modComposition'>) {
  return draft.modComposition && !sameValue(draft.modComposition, current?.modComposition) ? (draft.definitionOverrides ?? []).filter(ref => {
    const root = definitionLineageRootRef(localData, ref)
    return root.kind === 'catalog' && root.catalogId === draft.modComposition!.baseline.catalogId
  }) : []
}

export function GameRulesFields({ localData, value: draft, current, focus, disabled = false, onChange: update, modsEditor, calculation }: { localData: LocalData; value: GameSetupDraft; current?: Pick<GameSetupRevision, 'modComposition'>; focus?: GameSetupFocus; disabled?: boolean; onChange: (values: Partial<GameSetupDraft>) => void; modsEditor?: ReactNode; calculation?: BuildCalculationPlan }) {
  const [exactVersion, setExactVersion] = useState(false)
  const versionId = useId()
  const formRef = useRef<HTMLDivElement>(null)
  const library = useDefinitionLibrary()
  const catalogs = library.catalogs
  const rules = useMemo(() => resolveGameRules({ modComposition: draft.modComposition, mods: draft.mods, mode: draft.mode, difficulty: draft.difficulty, platform: draft.platform, gameVersion: draft.gameVersion }, catalogs), [catalogs, draft.modComposition, draft.mods, draft.mode, draft.difficulty, draft.platform, draft.gameVersion])
  const incompatibleOverrides = gameSetupOverrideConflicts(localData, draft, current)
  useEffect(() => {
    if (!focus) return
    const frame = window.requestAnimationFrame(() => {
      const target = formRef.current?.querySelector<HTMLElement>(`[data-game-setup-focus="${focus}"]`)
      for (let parent: HTMLElement | null | undefined = target; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true
      const control = target?.querySelector<HTMLElement>('select, input, button') ?? target
      if (control) { if (!control.matches('select, input, button')) control.tabIndex = -1; control.focus() }
      target?.scrollIntoView({ block: 'start' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [focus])
  const useNintendoChoices = () => update({ ...updateModSelections(draft, [
    ...CONFIRMED_SWITCH_MOD_SETUP.enabledMods.map(name => ({ name, state: 'enabled' as const })),
    ...CONFIRMED_SWITCH_MOD_SETUP.disabledMods.map(name => ({ name, state: 'disabled' as const })),
  ]) })
  const modNames = [...new Map([...KNOWN_MODS, ...recordedModNames(draft)].map(name => [normalizeModName(name), name])).values()]
  const enabledMods = modNames.filter(name => modState(draft, name) === 'enabled').length
  const layers = draft.modComposition?.layers ?? []
  const enabledLayers = layers.filter(layer => layer.enabled).length
  const version = draft.gameVersion.state === 'known' ? draft.gameVersion.value : ''
  const versions = [...new Set([DEFAULT_GAME_VERSION, NATIVE_GAME_DATA.source.gameVersion, ...Object.values(localData.gameSetups).flatMap(setup => setup.gameVersion.state === 'known' ? [setup.gameVersion.value] : [])])]
  const difficulty = draft.difficulty?.selection ?? { state: 'unknown' as const }
  const difficultyValue = difficulty.state === 'known' ? String(difficulty.value) : ''
  const legacyRules = draft.ppLimit.state !== 'known' || draft.ppLimit.value !== DEFAULT_PP_LIMIT || draft.slots.length !== PC_GAME_RULES.equipmentSlots || draft.slots.some((slot, index) => slot.equipmentRole !== SUGGESTED_BUILD_SLOTS[index]?.equipmentRole)
  return <div className="game-rules-fields" ref={formRef}>
    <fieldset className="game-setup-fields-group stack" disabled={disabled}>
      <section aria-label="Game context" className="game-setup-basics stack" data-game-setup-focus="setup">
        <div className="grid-2 game-setup-fields">
          <div className="stack game-setup-version"><ContextChoice label="Game version" value={draft.gameVersion} choices={versions} onChange={gameVersion => update({ gameVersion })}/><Button aria-controls={exactVersion ? versionId : undefined} aria-expanded={exactVersion} onClick={() => setExactVersion(value => !value)} tone="quiet" type="button">{exactVersion ? 'Hide exact version' : 'Enter exact version'}</Button>{exactVersion && <Field hint="Use the base game version shown in your game." label="Exact game version"><input aria-label="Exact game version" id={versionId} onChange={event => update({ gameVersion: textKnowledge(event.target.value) })} placeholder="For example: 1.6.9" value={version}/></Field>}</div>
          <Field label="Difficulty" hint={preservedHint(difficulty) ?? 'Choose the in-game setting. Its effects come from game and mod data.'}><select aria-label="Difficulty" onChange={event => update({ difficulty: { version: 1, selection: event.target.value === '' ? { state: 'unknown' } : { state: 'known', value: Number(event.target.value) } } })} value={difficultyValue}><option value="">Unknown or custom</option>{difficulty.state === 'known' && !rules.difficulties.some(value => value.id === difficulty.value) && <option value={difficultyValue}>Unavailable difficulty {difficulty.value}</option>}{rules.difficulties.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select></Field>
        </div>
        <details className="game-setup-base-details"><summary>Base game details · {knowledgeLabel(draft.platform)} · {knowledgeLabel(draft.mode)}</summary><div className="grid-2 game-setup-disclosure__body"><ContextChoice label="Platform" value={draft.platform} choices={PLATFORMS} onChange={platform => update({ platform })}/><ContextChoice label="Game mode" value={draft.mode} choices={MODES} onChange={mode => update({ mode })}/></div></details>
      </section>
      <details className="game-setup-disclosure game-setup-mods">
        <summary><span><strong>Mods</strong><small>{enabledLayers} imported versions enabled{enabledMods ? ` · ${enabledMods} named choices` : ''}</small></span><Icon name="chevron-down"/></summary>
        <div className="game-setup-disclosure__body stack">
          {modsEditor ?? <><div className="game-setup-imports"><ModLayersEditor catalogLock={draft.sourceGameSetupRevisionId ? localData.gameSetups[draft.sourceGameSetupRevisionId]?.catalogLock : undefined} composition={draft.modComposition} onChange={modComposition => update({ modComposition })}/></div>
          <details className="game-setup-named-mods"><summary>Mods without imported files</summary><div className="stack game-setup-disclosure__body"><p className="field__hint">Record mods by name. Calculations need their source files.</p><ModSelections value={draft} onChange={update}/><details className="game-setup-mod-help"><summary>Nintendo preset</summary><div className="stack"><p>Enables {CONFIRMED_SWITCH_MOD_SETUP.enabledMods.join(', ')} and disables {CONFIRMED_SWITCH_MOD_SETUP.disabledMods.join(', ')}. Review these choices against your save.</p><Button onClick={useNintendoChoices} tone="secondary" type="button">Apply Nintendo mod preset</Button></div></details></div></details>
          </>}{incompatibleOverrides.length > 0 && <InlineNotice title="Review personal override pins" tone="warning"><p>These custom definitions use an earlier catalog: {incompatibleOverrides.map(ref => localData.personalDefinitions[ref.definitionId]?.name ?? 'Unavailable definition').join(', ')}. Use the mod layer definitions to continue. Earlier Game Setups are kept.</p><Button onClick={() => update({ definitionOverrides: draft.definitionOverrides?.filter(ref => !incompatibleOverrides.includes(ref)) })} tone="secondary" type="button">Use layer definitions for these records</Button></InlineNotice>}
        </div>
      </details>
      <details className="game-setup-disclosure game-setup-derived">
        <summary><span><strong>Rules from game data</strong><small>{rules.genders.length} bonus profiles{rules.changes.length > 0 && ` · ${rules.changes.length} other rule ${rules.changes.length === 1 ? 'change' : 'changes'}`}{legacyRules ? ' · saved assumptions retained' : ''}</small></span><Icon name="chevron-down"/></summary>
        <GameRuleDetails calculation={calculation} draft={draft} legacyRules={legacyRules} rules={rules}/>
      </details>
    </fieldset>
  </div>
}

export function GameSetupEditor({ localData, current, focus, blocked, saveError, onSubmit, onRetry, onDirty, footer }: { localData: LocalData; current?: GameSetupRevision; focus?: GameSetupFocus; blocked: boolean; saveError?: string; onSubmit: (draft: GameSetupDraft) => Promise<void>; onRetry: () => Promise<void>; onDirty: (dirty: boolean) => void; footer: HTMLDivElement | null }) {
  const [initial] = useState(() => initialDraft(current))
  const [draft, setDraft] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [discardRequested, setDiscardRequested] = useState(false)
  const [fieldsKey, setFieldsKey] = useState(0)
  const formId = useId()
  const changed = !sameValue(initial, draft)
  const update = (values: Partial<GameSetupDraft>) => { setDraft(value => ({ ...value, ...values })); setError(undefined); setDiscardRequested(false) }
  const incompatibleOverrides = gameSetupOverrideConflicts(localData, draft, current)
  useEffect(() => { onDirty(changed); return () => onDirty(false) }, [changed, onDirty])
  useEffect(() => {
    if (!changed) return
    const preventLoss = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', preventLoss)
    return () => window.removeEventListener('beforeunload', preventLoss)
  }, [changed])
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (blocked || busy || (!changed && current) || incompatibleOverrides.length) return
    setBusy(true)
    setError(undefined)
    try { await onSubmit({ ...draft, label: draft.label.trim() }); onDirty(false) }
    catch (reason) { setError(formatAppError(reason, 'The Game Setup revision could not be saved.')) }
    finally { setBusy(false) }
  }
  const retry = async () => {
    setBusy(true)
    setError(undefined)
    try { await onRetry() } catch (reason) { setError(formatAppError(reason, 'The Game Setup revision could not be saved.')) } finally { setBusy(false) }
  }
  return <form className="game-setup-form stack" id={formId} onInvalid={event => {
    for (let parent: HTMLElement | null = event.target as HTMLElement; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true
  }} onSubmit={submit}>
    <div className="game-setup-context"><div><h2>{current ? 'Saved Game Setup' : 'New Game Setup'}</h2><p>Save rules to reuse in Builds. Your Playthrough stays unchanged.</p>{current && <p>Saved revision {current.revision}</p>}</div></div>
    <Field label="Game Setup label" required><input disabled={busy || blocked} onChange={event => update({ label: event.target.value })} placeholder="For example: PC with 1 PP Passives" required value={draft.label}/></Field>
    <GameRulesFields current={current} disabled={busy || blocked} focus={focus} key={fieldsKey} localData={localData} onChange={update} value={draft}/>
    {footer && createPortal(<>{(error || saveError) && <InlineNotice title="Game Setup not saved" tone="danger">{error ?? saveError} Your configuration remains available.{saveError && <Button disabled={busy} onClick={() => void retry()} tone="secondary" type="button">Retry save</Button>}</InlineNotice>}{discardRequested ? <div className="game-setup-discard" role="alert"><p>Discard your unsaved setup changes?</p><div className="cluster"><Button onClick={() => { setDraft(initial); setError(undefined); setDiscardRequested(false); setFieldsKey(value => value + 1) }} tone="danger" type="button">Discard edits</Button><Button onClick={() => setDiscardRequested(false)} tone="secondary" type="button">Keep editing</Button></div></div> : <div className="game-setup-save-bar"><div aria-live="polite"><strong>{changed ? 'Unsaved changes' : current ? 'No unsaved changes' : 'New Game Setup'}</strong><p>Saves a reusable Game Setup.</p></div><div className="cluster"><Button disabled={!changed || busy || blocked} onClick={() => setDiscardRequested(true)} tone="quiet" type="button">Discard changes</Button><Button disabled={busy || blocked || !draft.label.trim() || (!changed && !!current) || incompatibleOverrides.length > 0} form={formId} icon="check" type="submit">{busy ? 'Saving...' : current ? 'Save Game Setup' : 'Create Game Setup'}</Button></div></div>}</>, footer)}
  </form>
}
