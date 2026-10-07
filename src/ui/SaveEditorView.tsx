import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { BUNDLED_MOD_LIBRARY, bundledModEditableSource } from '../catalog/mod-library'
import { SAVE_EDITOR_CATALOG } from '../catalog/save-editor'
import { NATIVE_GAME_DATA } from '../catalog/native-game'
import { nativeGameplayScopeLabel } from '../domain/native-game'
import { CRYSTAL_SAVE_LIMITS, CRYSTAL_SAVE_MIN_VERSION, CRYSTAL_SAVE_VERSION, crystalSaveVersion, isSupportedCrystalSaveVersion, decodeCrystalSave, encodeCrystalSave, type CrystalSave } from '../interchange/crystal-save'
import { previewCrystalEdit } from '../interchange/crystal-edit'
import { editSave, inspectSave, previewSaveChanges, previewSaveAdditions, previewVanillaConversion, saveEditorChoices, SAVE_EDITOR_MAX_CURRENCY, type SaveEditCommand } from '../domain/save-editor'
import { createSaveEditorModSource, resolveSaveEditorMods, saveEditorModProjectId, saveEditorModSourceKey, type SaveEditorModSource } from '../domain/save-editor-mods'
import { MAX_MOD_SOURCE_BYTES, type BundledLibraryMod } from '../domain/mod-library'
import type { LocalData } from '../domain/types'
import { Badge, Button, Field, InlineNotice, ScreenHeader } from './components'
import { DefinitionLibraryContext } from './definitions'
import type { DraftActions, DraftChangeHandler } from './drafts'
import { downloadBytes } from './model'
import { SavePartyEditor } from './SavePartyEditor'
import { saveEditorLevelHint } from './save-editor-levels'
import { useNavigationNotice } from './useNavigationNotice'
import { Icon, type IconName } from './icons'
import './save-editor.css'

const INVENTORY_PAGE_SIZE = 30
const MAX_MOD_DEFINITION_FILES = 100
const MAX_BUNDLED_SAVE_SOURCE_CACHE = 8
const SAVE_EDITOR_RULES_LABEL = nativeGameplayScopeLabel(NATIVE_GAME_DATA.source.platform, NATIVE_GAME_DATA.source.gameVersion)
const SAVE_EDITOR_SECTIONS: readonly { readonly id: string; readonly label: string; readonly icon: IconName; readonly editableOnly?: boolean }[] = [
  { id: 'party', label: 'Party', icon: 'team' },
  { id: 'inventory', label: 'Inventory', icon: 'box' },
  { id: 'money', label: 'Money', icon: 'chest' },
  { id: 'presets', label: 'Unlocks & presets', icon: 'spark', editableOnly: true },
]
function focusSaveSection(id: string) {
  // Buttons move within the editor without replacing the application's hash route
  const target = document.getElementById(`save-editor-${id}`)
  target?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  const heading = target?.querySelector('h2')
  heading?.setAttribute('tabindex', '-1')
  heading?.focus({ preventScroll: true })
}
const BULK_ACTIONS = [
  { type: 'unlock-jobs', title: 'Unlock all classes', description: 'Unlock every class defined for this save for all members. Learned skills and equipped classes stay unchanged.', button: 'Review class unlocks' },
  { type: 'master-jobs', title: 'Master classes and skills', description: 'Learn the supported class abilities and learnable passives for every member, with class mastery and JP.', button: 'Review class mastery' },
  { type: 'reveal-maps', title: 'Reveal stored maps', description: 'Reveal maps already stored in this save. Missing regions are not added.', button: 'Review map reveal' },
  { type: 'overpowered', title: 'Overpowered preset', description: 'Raise the party to level 99, master classes and skills, and add money, travel items, and a broad equipment inventory. Keep the party\'s equipped loadouts.', button: 'Review overpowered preset' },
] as const

interface OpenSave {
  readonly filename: string
  readonly originalBytes: Uint8Array
  readonly original?: CrystalSave
  readonly draft?: CrystalSave
  readonly issue?: string
}

interface ReviewedChange {
  readonly title: string
  readonly draft: CrystalSave
  readonly changes: readonly string[]
  readonly additions?: readonly string[]
}

function SaveChanges({ changes, additions }: { readonly changes: readonly string[]; readonly additions?: readonly string[] }) {
  const added = new Set(additions)
  return <ul className="save-editor__changes">{changes.map((change, index) => <li data-added={added.has(change) || undefined} key={index}>{added.has(change) && <Badge tone="info">New</Badge>}{change}</li>)}</ul>
}

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason)
}

function wholeNumber(value: string, label: string) {
  if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(Number(value))) throw new Error(`${label} must be a whole number of zero or more.`)
  return Number(value)
}

function invalidWholeNumber(value: string | undefined) {
  return value !== undefined && (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(Number(value)))
}

function exportFilename(filename: string) {
  return `${filename.replace(/\.sav$/i, '')}-edited.sav`
}

function currencyDisplay(copper: number) {
  return `${Math.floor(copper / 10_000).toLocaleString()} gold · ${Math.floor(copper / 100) % 100} silver · ${copper % 100} copper`
}

function savedDate(save: CrystalSave) {
  const date = save.header.lastUpdated
  if (!date) return 'Not stored in this format'
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.year}-${pad(date.month)}-${pad(date.day)} ${pad(date.hour)}:${pad(date.minute)}:${pad(date.second)}`
}

function playTime(save: CrystalSave) {
  const time = save.header.playTime
  return `${time.days ? `${time.days}d ` : ''}${time.hours}h ${time.minutes}m`
}

function bundledDefinitionsForSave(save: CrystalSave) {
  const active = new Map(save.header.mods.map(mod => [mod.id, mod]))
  const historical = new Set(save.header.modIdMaps.map(map => map.modId).filter(id => !active.has(id)))
  return BUNDLED_MOD_LIBRARY.filter(mod => {
    const id = saveEditorModProjectId(mod.id)
    const saved = active.get(id)
    if (!saved) return historical.has(id)
    return (mod.declaredVersion ?? '') === saved.version && (saved.steamWorkshopFileId === 0n || mod.steamWorkshopFileId === saved.steamWorkshopFileId.toString())
  })
}

const bundledSaveEditorSources = new Map<string, Promise<SaveEditorModSource>>()

function loadBundledSaveEditorSource(mod: BundledLibraryMod): Promise<SaveEditorModSource> {
  const key = `${mod.key}:${mod.sourceDigest}`
  const cached = bundledSaveEditorSources.get(key)
  if (cached) {
    bundledSaveEditorSources.delete(key)
    bundledSaveEditorSources.set(key, cached)
    return cached
  }
  // Bundled bytes are content-addressed; reuse parsing across saves and discard failed loads for retry
  const loading = (async () => {
    const source = await bundledModEditableSource(mod)
    const preview = await previewCrystalEdit(new TextEncoder().encode(source.text), source.filename)
    if (preview.errors.length) throw new Error(preview.errors[0]!.message)
    const catalog = preview.proposed.catalogs[0]
    if (!catalog) throw new Error(`${source.filename} is not a Crystal Edit project`)
    return createSaveEditorModSource(catalog, preview.warnings, 'bundled', mod.key)
  })().catch(reason => {
    if (bundledSaveEditorSources.get(key) === loading) bundledSaveEditorSources.delete(key)
    throw reason
  })
  bundledSaveEditorSources.set(key, loading)
  // Bound retained decoded catalogs for long-lived editor tabs
  if (bundledSaveEditorSources.size > MAX_BUNDLED_SAVE_SOURCE_CACHE) bundledSaveEditorSources.delete(bundledSaveEditorSources.keys().next().value!)
  return loading
}

export function SaveEditorView({ localData: localDataProp, onDraftChange }: { readonly localData?: LocalData; readonly onDraftChange?: DraftChangeHandler } = {}) {
  const definitionLibrary = useContext(DefinitionLibraryContext)
  const localData = localDataProp ?? definitionLibrary?.localData
  const [opened, setOpened] = useState<OpenSave>()
  const [pending, setPending] = useState<Record<string, string>>({})
  const [revision, setRevision] = useState(0)
  const [exportedRevision, setExportedRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  const [modBusy, setModBusy] = useState(false)
  const [bundledBusy, setBundledBusy] = useState(false)
  const [bundledIssue, setBundledIssue] = useState<string>()
  const [modSources, setModSources] = useState<readonly SaveEditorModSource[]>([])
  const [error, setErrorMessage] = useState<string>()
  const { noticeRef: errorNoticeRef, revealNotice: revealErrorNotice } = useNavigationNotice()
  const setError = useCallback((message: string | undefined) => {
    setErrorMessage(message)
    // Failed edits can originate far below the notice, including retries with identical text
    if (message) revealErrorNotice()
  }, [revealErrorNotice])
  const [status, setStatus] = useState<string>()
  const [review, setReview] = useState<ReviewedChange>()
  const [partyDraftDirty, setPartyDraftDirty] = useState(false)
  const [query, setQuery] = useState('')
  const [inventoryKind, setInventoryKind] = useState('all')
  const [stockFilter, setStockFilter] = useState('all')
  const [inventoryLimit, setInventoryLimit] = useState(INVENTORY_PAGE_SIZE)
  const fileInput = useRef<HTMLInputElement>(null)
  const modInput = useRef<HTMLInputElement>(null)
  const previewHeading = useRef<HTMLHeadingElement>(null)
  const reviewTrigger = useRef<HTMLButtonElement | null>(null)
  const openRequest = useRef(0)
  const modRequest = useRef(0)
  const bundledRequest = useRef(0)
  const actionsRef = useRef<DraftActions | undefined>(undefined)
  const registeredActions = useMemo<DraftActions>(() => ({ save: () => actionsRef.current?.save() ?? Promise.resolve(false), discard: () => actionsRef.current?.discard() }), [])
  const modResolution = useMemo(() => opened?.draft ? resolveSaveEditorMods(opened.draft, SAVE_EDITOR_CATALOG, modSources) : undefined, [modSources, opened?.draft])
  const summary = useMemo(() => opened?.draft ? inspectSave(opened.draft, SAVE_EDITOR_CATALOG, modSources) : undefined, [modSources, opened?.draft])
  const conversion = useMemo(() => opened?.draft ? previewVanillaConversion(opened.draft, SAVE_EDITOR_CATALOG) : undefined, [opened?.draft])
  const choices = useMemo(() => saveEditorChoices(modResolution?.catalog ?? SAVE_EDITOR_CATALOG), [modResolution?.catalog])
  const changes = useMemo(() => opened?.original && opened.draft && opened.original !== opened.draft ? previewSaveChanges(opened.original, opened.draft, SAVE_EDITOR_CATALOG, modSources) : [], [modSources, opened?.original, opened?.draft])
  const additions = useMemo(() => opened?.original && opened.draft && opened.original !== opened.draft ? previewSaveAdditions(opened.original, opened.draft, SAVE_EDITOR_CATALOG, modSources) : [], [modSources, opened?.original, opened?.draft])
  const hasPending = Object.keys(pending).length > 0
  const optionalModCleanup = !!summary?.editable && !modResolution?.hasHeaderModState
  // Preview pending copper without applying it to the working save
  const currencyInput = pending.currency ?? String(summary?.currency ?? 0)
  const currencyValue = Number(currencyInput)
  const currencyInvalid = invalidWholeNumber(currencyInput) || currencyValue > SAVE_EDITOR_MAX_CURRENCY
  const dirty = revision !== exportedRevision || hasPending || partyDraftDirty || busy
  const locked = busy || modBusy || bundledBusy || !summary?.editable || !!review
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const inventory = (summary?.inventory ?? []).filter(row => (inventoryKind === 'all' || row.kind === inventoryKind)
    && (stockFilter === 'all' || row.count > 0)
    && `${row.name} ${row.id}`.toLocaleLowerCase().includes(normalizedQuery))
  const detectedMods = useMemo(() => {
    const active = (modResolution?.activeMods ?? []).map(mod => {
      const candidates = modSources.filter(source => source.id === mod.id && (source.version ?? '') === mod.version)
      const saved = opened?.draft?.header.mods.find(candidate => candidate.id === mod.id && candidate.version === mod.version)
      const matches = candidates.filter(source => !saved || saved.steamWorkshopFileId === 0n || source.steamWorkshopFileId === saved.steamWorkshopFileId.toString())
      const source = matches.length === 1 ? matches[0] : undefined
      return { id: mod.id, title: mod.title, version: mod.version, active: true, matched: mod.matched, source }
    })
    const historical = (modResolution?.historicalModIds ?? []).map(id => {
      const sources = modSources.filter(source => source.id === id)
      const bundled = BUNDLED_MOD_LIBRARY.find(mod => saveEditorModProjectId(mod.id) === id)
      const source = sources.find(candidate => candidate.origin === 'file') ?? sources[0]
      return { id, title: source?.title ?? bundled?.title ?? id, version: undefined, active: false, matched: sources.length > 0, source }
    })
    return [...active, ...historical]
  }, [modResolution, modSources, opened?.draft])

  useEffect(() => {
    actionsRef.current = { save: async () => exportEdited(), discard: resetDraft }
  })
  useEffect(() => { onDraftChange?.(dirty, registeredActions) }, [dirty, onDraftChange, registeredActions])
  useEffect(() => () => { openRequest.current++; modRequest.current++; bundledRequest.current++; onDraftChange?.(false) }, [onDraftChange])
  useEffect(() => {
    if (!opened?.original) return
    const candidates = bundledDefinitionsForSave(opened.original)
    const request = ++bundledRequest.current
    setBundledIssue(undefined)
    if (!candidates.length) { setBundledBusy(false); return }
    setBundledBusy(true)
    void Promise.all(candidates.map(async mod => {
      try { return { source: await loadBundledSaveEditorSource(mod) } }
      catch (reason) { return { issue: `${mod.title}: ${errorMessage(reason)}` } }
    })).then(results => {
      if (request !== bundledRequest.current) return
      const loaded = results.flatMap(result => result.source ? [result.source] : [])
      const issues = results.flatMap(result => result.issue ? [result.issue] : [])
      if (loaded.length) setModSources(current => {
        const existing = new Set(current.map(saveEditorModSourceKey))
        return [...current, ...loaded.filter(source => !existing.has(saveEditorModSourceKey(source)))]
      })
      setBundledIssue(issues.length ? `Bundled mod definitions could not be loaded. ${issues.join(' ')}` : undefined)
    }).finally(() => { if (request === bundledRequest.current) setBundledBusy(false) })
  }, [opened?.original])
  useEffect(() => {
    if (review) previewHeading.current?.focus()
    else if (reviewTrigger.current) { reviewTrigger.current.focus(); reviewTrigger.current = null }
  }, [review])

  function resetDraft() {
    openRequest.current++
    setOpened(value => value ? { ...value, draft: value.original } : value)
    setPending({}); setPartyDraftDirty(false); setRevision(0); setExportedRevision(0); setReview(undefined); setError(undefined); setStatus(undefined); setBusy(false)
    onDraftChange?.(false)
  }

  function setField(key: string, value: string, original: string) {
    setPending(current => {
      const next = { ...current }
      if (value === original) delete next[key]
      else next[key] = value
      return next
    })
    setStatus(undefined)
  }

  function apply(command: SaveEditCommand, fields: readonly string[]) {
    if (!opened?.draft || locked) return
    try {
      const draft = editSave(opened.draft, SAVE_EDITOR_CATALOG, command, new Date(), modSources)
      const nextChanges = previewSaveChanges(opened.draft, draft, SAVE_EDITOR_CATALOG, modSources)
      if (nextChanges.length) { setOpened({ ...opened, draft }); setRevision(value => value + 1) }
      setPending(current => { const next = { ...current }; fields.forEach(key => { delete next[key] }); return next })
      setError(undefined); setStatus(nextChanges.length ? 'Changes applied to the draft. Export a save to use them in the game.' : 'This value already matches the draft.')
    } catch (reason) { setError(errorMessage(reason)) }
  }

  async function openFile(file: File) {
    if ((revision !== exportedRevision || hasPending || partyDraftDirty) && !window.confirm('Open another save and discard the changes that have not been exported?')) return
    const request = ++openRequest.current
    if (file.size > CRYSTAL_SAVE_LIMITS.maxFileBytes) { setBusy(false); setError('This file exceeds the 64 MiB Save Editor limit. The open draft has not changed.'); return }
    if (!file.size) { setBusy(false); setError('This file is empty. Choose a Crystal Project .sav file.'); return }
    setBusy(true); setError(undefined); setStatus(undefined)
    try {
      const originalBytes = new Uint8Array(await file.arrayBuffer())
      if (request !== openRequest.current) return
      if (originalBytes.byteLength > CRYSTAL_SAVE_LIMITS.maxFileBytes) throw new Error('This file exceeds the 64 MiB Save Editor limit.')
      let next: OpenSave
      const version = crystalSaveVersion(originalBytes[0])
      if (!isSupportedCrystalSaveVersion(version)) next = { filename: file.name, originalBytes, issue: `Save format ${version} is newer than the inspected native reader. Supported formats are ${CRYSTAL_SAVE_MIN_VERSION} to ${CRYSTAL_SAVE_VERSION}. The original file is available unchanged.` }
      else {
        const original = decodeCrystalSave(originalBytes)
        next = { filename: file.name, originalBytes, original, draft: original }
      }
      setOpened(next); setPending({}); setPartyDraftDirty(false); setRevision(0); setExportedRevision(0); setReview(undefined)
      setModSources(current => current.filter(source => source.origin === 'file'))
      setQuery(''); setInventoryKind('all'); setStockFilter('all'); setInventoryLimit(INVENTORY_PAGE_SIZE)
      setStatus('Save opened. The original remains unchanged.')
    } catch (reason) { if (request === openRequest.current) setError(`${errorMessage(reason)}${opened ? ' The open draft has not changed.' : ''}`) }
    finally { if (request === openRequest.current) setBusy(false) }
  }

  async function openModFiles(files: readonly File[]) {
    if (!files.length) return
    if (files.length > MAX_MOD_DEFINITION_FILES) { setError(`Choose at most ${MAX_MOD_DEFINITION_FILES} mod definition files at once.`); return }
    const request = ++modRequest.current
    setModBusy(true); setError(undefined); setStatus(undefined)
    try {
      const loaded: SaveEditorModSource[] = []
      for (const file of files) {
        if (!file.size) throw new Error(`${file.name} is empty`)
        if (file.size > MAX_MOD_SOURCE_BYTES) throw new Error(`${file.name} exceeds the 96 MiB Crystal Edit limit`)
        const bytes = new Uint8Array(await file.arrayBuffer())
        if (request !== modRequest.current) return
        const preview = await previewCrystalEdit(bytes, file.name)
        if (preview.errors.length) throw new Error(preview.errors[0]!.message)
        const catalog = preview.proposed.catalogs[0]
        if (!catalog) throw new Error(`${file.name} is not a Crystal Edit project`)
        loaded.push(createSaveEditorModSource(catalog, preview.warnings, 'file'))
      }
      if (request !== modRequest.current) return
      setModSources(current => {
        const keys = new Set(loaded.map(saveEditorModSourceKey))
        return [...current.filter(source => !keys.has(saveEditorModSourceKey(source))), ...loaded]
      })
      setStatus(`${loaded.length} mod definition ${loaded.length === 1 ? 'file' : 'files'} loaded for this tab.`)
    } catch (reason) { if (request === modRequest.current) setError(`Mod definition import failed: ${errorMessage(reason)}.`) }
    finally { if (request === modRequest.current) setModBusy(false) }
  }

  function exportEdited() {
    if (!opened?.draft || !summary?.editable || busy || modBusy || bundledBusy) return false
    if (hasPending || partyDraftDirty) { setError('Apply or discard pending fields and loadout choices before exporting. Unreviewed input has not been included in the draft.'); return false }
    if (review) { setError('Apply or cancel the reviewed changes before exporting.'); return false }
    try {
      const now = new Date()
      const exported = changes.length && opened.draft.header.lastUpdated ? {
        ...opened.draft,
        header: { ...opened.draft.header, lastUpdated: { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, day: now.getUTCDate(), hour: now.getUTCHours(), minute: now.getUTCMinutes(), second: now.getUTCSeconds() } },
      } : opened.draft
      const bytes = encodeCrystalSave(exported)
      downloadBytes(bytes, exportFilename(opened.filename))
      setExportedRevision(revision); setError(undefined); setStatus('Download started. Keep the original as a backup before replacing a game save.')
      onDraftChange?.(false)
      return true
    } catch (reason) { setError(`Export failed: ${errorMessage(reason)}`); return false }
  }

  function downloadOriginal() {
    if (!opened) return
    try {
      downloadBytes(opened.originalBytes, `original-${opened.filename}`)
      setError(undefined); setStatus('Original download started. The draft and pending input have not changed.')
    } catch (reason) { setError(`Original download failed: ${errorMessage(reason)}`) }
  }

  function prepareReview(action: typeof BULK_ACTIONS[number], trigger: HTMLButtonElement) {
    if (!opened?.draft || locked || hasPending) return
    try {
      const draft = editSave(opened.draft, SAVE_EDITOR_CATALOG, { type: action.type }, new Date(), modSources)
      reviewTrigger.current = trigger
      setReview({ title: action.title, draft, changes: previewSaveChanges(opened.draft, draft, SAVE_EDITOR_CATALOG, modSources), additions: previewSaveAdditions(opened.draft, draft, SAVE_EDITOR_CATALOG, modSources) })
      setError(undefined); setStatus(undefined)
    } catch (reason) { setError(errorMessage(reason)) }
  }

  function prepareVanillaReview(trigger: HTMLButtonElement) {
    if (!conversion?.convertible || !conversion.draft || busy || modBusy || bundledBusy || hasPending || review) return
    reviewTrigger.current = trigger
    setReview({ title: 'Remove mod data', draft: conversion.draft, changes: conversion.changes })
    setError(undefined); setStatus(undefined)
  }

  function prepareLoadoutReview(title: string, command: Extract<SaveEditCommand, { type: 'loadout' }>, trigger: HTMLButtonElement) {
    if (!opened?.draft || locked || hasPending) return
    try {
      const draft = editSave(opened.draft, SAVE_EDITOR_CATALOG, command, new Date(), modSources)
      reviewTrigger.current = trigger
      setReview({ title, draft, changes: previewSaveChanges(opened.draft, draft, SAVE_EDITOR_CATALOG, modSources), additions: previewSaveAdditions(opened.draft, draft, SAVE_EDITOR_CATALOG, modSources) })
      setError(undefined); setStatus(undefined)
    } catch (reason) { setError(errorMessage(reason)) }
  }

  function applyReview() {
    if (!review || !opened) return
    setOpened({ ...opened, draft: review.draft })
    if (review.changes.length) setRevision(value => value + 1)
    setReview(undefined); setError(undefined); setStatus('Reviewed changes applied. Export a save to use them in the game.')
  }

  return <div className="save-editor">
    <ScreenHeader eyebrow="Tools" title="Save Editor" description="Edit a Crystal Project save in your browser, then download a separate copy." unsavedObject={dirty} actions={<><Button tone="secondary" disabled={busy || modBusy || bundledBusy} onClick={() => fileInput.current?.click()}>{opened ? 'Open another save' : 'Open save'}</Button>{opened?.draft && <Button disabled={locked || hasPending || partyDraftDirty} icon="download" onClick={exportEdited}>Export edited save</Button>}</>}/>
    <input className="save-editor__file-input" type="file" accept=".sav,application/octet-stream" aria-label="Open Crystal Project save" ref={fileInput} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void openFile(file) }}/>
    <input className="save-editor__file-input" type="file" multiple accept=".json,application/json" aria-label="Add Crystal Edit mod definitions" ref={modInput} onChange={event => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; if (files.length) void openModFiles(files) }}/>
    {!opened && <section className="save-editor__panel save-editor__intro"><div><h2>Edit a game save</h2><p>Edit party members, inventory, money, and unlocks. Open a <code>.sav</code> file to get started.</p><Button disabled={busy || modBusy || bundledBusy} onClick={() => fileInput.current?.click()}>Choose a save file</Button></div><div className="save-editor__scope"><strong>Your original stays unchanged</strong><p>Your file stays in this tab and is never uploaded. Export edits before closing the editor. Your Playthrough records stay unchanged.</p><p>Supports older save formats and keeps their format when exporting. Unsupported game configurations are read-only.</p></div></section>}
    {busy && <InlineNotice title="Opening save">Reading and validating the selected file...</InlineNotice>}
    {modBusy && <InlineNotice title="Reading mod definitions">Validating Crystal Edit project data in this tab...</InlineNotice>}
    {bundledBusy && <InlineNotice title="Matching bundled mod definitions">Checking the save against CryKit's bundled Crystal Edit projects...</InlineNotice>}
    {error && <div ref={errorNoticeRef} tabIndex={-1} aria-label="Save Editor error"><InlineNotice title="Save Editor needs attention" tone="danger">{error}</InlineNotice></div>}
    {status && !error && <p className="save-editor__note" role="status">{status}</p>}
    {opened && <>
      <section className="save-editor__panel" aria-label="Open save details"><div className="save-editor__file-heading"><h2>{opened.filename}</h2><span className="save-editor__state">{dirty ? 'Changes not exported' : revision > 0 ? 'Draft exported' : 'Original open'}</span></div><dl className="save-editor__facts">{opened.original && <><div><dt>Saved date</dt><dd>{savedDate(opened.original)}</dd></div><div><dt>Play time</dt><dd>{playTime(opened.original)}</dd></div></>}{summary && <><div><dt>Game mode</dt><dd>{summary.mode.name}</dd></div><div><dt>Randomizer</dt><dd>{summary.randomized ? 'Enabled' : 'Disabled'}</dd></div><div><dt>Party</dt><dd>{summary.members.length} members</dd></div><div><dt>Level cap</dt><dd>{summary.levelCap}</dd></div></>}</dl><dl className="save-editor__facts save-editor__facts--format"><div><dt>Original size</dt><dd>{opened.originalBytes.byteLength.toLocaleString()} bytes</dd></div><div><dt>Save format</dt><dd>{opened.original?.header.version ?? crystalSaveVersion(opened.originalBytes[0])}</dd></div><div><dt>Editing rules</dt><dd>{SAVE_EDITOR_RULES_LABEL}</dd></div></dl><div className="save-editor__actions save-editor__original-actions"><Button tone="secondary" onClick={downloadOriginal}>Download original</Button>{opened.draft && <Button tone="quiet" disabled={busy || modBusy || bundledBusy || (!changes.length && !hasPending && !partyDraftDirty && !review)} onClick={() => { if (window.confirm('Reset all draft edits and pending input to the original save?')) resetDraft() }}>Reset to original</Button>}</div></section>
      {opened.draft && (modResolution?.hasHeaderModState || conversion?.relevant || modSources.length > 0) && <section className="save-editor__panel save-editor__mods" aria-label="Save mods"><h2>Save mods</h2><p>Bundled definitions load automatically. Add JSON for missing active or historical mod versions. Imported text and formulas are never run.</p>{detectedMods.length ? <ul className="save-editor__mod-list">{detectedMods.map(mod => <li key={`${mod.active ? 'active' : 'historical'}:${mod.id}:${mod.version ?? ''}`}><input className="save-editor__mod-check" type="checkbox" checked={mod.matched} disabled aria-label={`${mod.title} definition ${mod.matched ? 'available' : 'unavailable'}`}/><span className="save-editor__mod-copy"><strong>{mod.title}</strong><small>{mod.active ? `${mod.version || 'Unversioned'} · Active · ${mod.id}` : `Disabled mod · Saved revision unavailable · ${mod.id}`}</small></span><span className={mod.matched ? 'save-editor__mod-state save-editor__mod-state--matched' : 'save-editor__mod-state'}>{mod.matched ? mod.active ? `${mod.source?.origin === 'bundled' ? 'Bundled' : 'Imported'} definition matched` : `${mod.source?.origin === 'bundled' ? 'Bundled' : 'Imported'} project identified` : bundledBusy ? 'Checking bundled definitions...' : mod.active ? 'Definition required' : 'Project definition unavailable'}</span></li>)}</ul> : conversion?.relevant ? <p>{optionalModCleanup ? "No active mods are recorded. Leftover records are preserved and do not prevent editing this save." : "No active mod metadata remains, but indexed save state extends beyond the native definitions."}</p> : <p>No mods are recorded in this save.</p>}{bundledIssue && <InlineNotice title="Bundled mod match needs attention" tone="warning">{bundledIssue} Add the matching Crystal Edit JSON manually.</InlineNotice>}{modSources.length > 0 && <p className="save-editor__note">Available in this tab: {modSources.map(source => `${source.title} ${source.version ?? '(unversioned)'} (${source.origin === 'bundled' ? 'bundled' : 'imported'})`).join(', ')}</p>}<div className="save-editor__actions"><Button tone="secondary" disabled={busy || modBusy || bundledBusy || !!review} onClick={() => modInput.current?.click()}>Add missing mod JSON</Button></div>{conversion?.relevant && <div className="save-editor__conversion"><h3>{optionalModCleanup ? "Optional cleanup" : "Remove mod data"}</h3><p>{optionalModCleanup ? "Cleanup is optional. Review it to remove supported leftover mod records." : "Removes mod data that CryKit can identify and marks the save as unmodded. Game mode stays unchanged. Rewards and other changes that can't be traced to a mod remain."}</p>{conversion.blockers.length > 0 && <ul className="save-editor__error-list">{conversion.blockers.map((blocker, index) => <li key={index}>{blocker}</li>)}</ul>}<Button tone={optionalModCleanup ? "secondary" : "primary"} disabled={!conversion.convertible || busy || modBusy || bundledBusy || hasPending || partyDraftDirty || !!review} onClick={event => prepareVanillaReview(event.currentTarget)}>Review mod data removal</Button></div>}</section>}
      {(opened.issue || summary && !summary.editable) && <InlineNotice title="Read-only save" tone="warning">{opened.issue ?? <><p>This save cannot be edited with the available definitions and rules.</p><ul className="save-editor__error-list">{summary!.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></>}</InlineNotice>}
      {hasPending && <InlineNotice title="Pending input"><div className="save-editor__pending"><p>Apply the edited fields before reviewing bulk changes or exporting.</p><Button tone="secondary" disabled={busy} onClick={() => { setPending({}); setError(undefined) }}>Discard pending input</Button></div></InlineNotice>}
      {review && <section className="save-editor__panel save-editor__preview" aria-label="Review bulk changes"><h2 ref={previewHeading} tabIndex={-1}>Review: {review.title}</h2><p>Review the proposed changes, apply them to the draft, then export.</p>{review.changes.length ? <SaveChanges additions={review.additions} changes={review.changes}/> : <p>The draft already matches this preset.</p>}<div className="save-editor__actions"><Button disabled={busy || !review.changes.length} onClick={applyReview}>Apply reviewed changes</Button><Button tone="secondary" onClick={() => { setReview(undefined); setError(undefined) }}>Cancel review</Button></div></section>}
      {opened.draft && <section className="save-editor__panel save-editor__draft" aria-label="Draft and export"><h2>Working copy</h2>{changes.length ? <><p className="save-editor__note">Export edited save downloads a separate copy. Your original stays unchanged.</p><details className="save-editor__review" open><summary>Review applied changes ({changes.length})</summary><SaveChanges additions={additions} changes={changes}/></details></> : <p className="save-editor__note">The draft matches the original save. Export downloads a separate copy.</p>}{partyDraftDirty && <p>Pending loadout choices below are not included here.</p>}</section>}
      {summary && <nav aria-label="Save Editor sections" className="save-editor__navigation">{SAVE_EDITOR_SECTIONS.filter(section => !section.editableOnly || summary.editable).map(section => <Button key={section.id} onClick={() => focusSaveSection(section.id)} tone="secondary"><Icon name={section.icon}/>{section.label}</Button>)}</nav>}
      {summary && <>
        <div id="save-editor-party">{localData && opened.draft ? <SavePartyEditor localData={localData} locked={locked} modSources={modSources} onApplyMember={apply} onDraftChange={setPartyDraftDirty} onError={setError} onFieldChange={setField} onReview={prepareLoadoutReview} pending={pending} save={opened.draft} summary={summary}/> : <section className="save-editor__panel" aria-label="Party editor"><h2>Party</h2><p>Apply each member's changes to the draft. Changing class or subclass returns gear to inventory. The new main class determines future growth; past growth stays unchanged. Re-equip gear in game.</p><div className="save-editor__members">{summary.members.map(member => {
          const prefix = `member.${member.index}.`
          const keys = ['name', 'level', 'jobId', 'subJobId'].map(key => `${prefix}${key}`)
          const memberPending = keys.some(key => pending[key] !== undefined)
          return <form className="save-editor__member" key={member.index} onSubmit={event => {
            event.preventDefault()
            try {
              apply({ type: 'member', index: member.index,
                ...(pending[`${prefix}name`] !== undefined ? { name: pending[`${prefix}name`] } : {}),
                ...(pending[`${prefix}level`] !== undefined ? { level: wholeNumber(pending[`${prefix}level`], 'Level') } : {}),
                ...(pending[`${prefix}jobId`] !== undefined ? { jobId: wholeNumber(pending[`${prefix}jobId`], 'Class') } : {}),
                ...(pending[`${prefix}subJobId`] !== undefined ? { subJobId: pending[`${prefix}subJobId`] === '' ? null : wholeNumber(pending[`${prefix}subJobId`], 'Subclass') } : {}),
              }, keys)
            } catch (reason) { setError(errorMessage(reason)) }
          }}><h3>{member.index + 1}. {member.name}</h3><div className="save-editor__fields"><Field label="Name"><input aria-label={`Member ${member.index + 1} name`} disabled={locked} value={pending[`${prefix}name`] ?? member.name} onChange={event => setField(`${prefix}name`, event.target.value, member.name)}/></Field><Field label="Level" hint={saveEditorLevelHint(summary)}><input aria-label={`Member ${member.index + 1} level`} inputMode="numeric" aria-invalid={invalidWholeNumber(pending[`${prefix}level`]) || undefined} disabled={locked} value={pending[`${prefix}level`] ?? String(member.level)} onChange={event => setField(`${prefix}level`, event.target.value, String(member.level))}/></Field><Field label="Class"><select aria-label={`Member ${member.index + 1} class`} disabled={locked} value={pending[`${prefix}jobId`] ?? String(member.jobId)} onChange={event => setField(`${prefix}jobId`, event.target.value, String(member.jobId))}>{!choices.jobs.some(job => job.id === member.jobId) && <option value={member.jobId}>Unknown class #{member.jobId}</option>}{choices.jobs.map(job => <option key={job.id} value={job.id}>{job.name}</option>)}</select></Field><Field label="Subclass"><select aria-label={`Member ${member.index + 1} subclass`} disabled={locked} value={pending[`${prefix}subJobId`] ?? (member.subJobId === null ? '' : String(member.subJobId))} onChange={event => setField(`${prefix}subJobId`, event.target.value, (member.subJobId === null ? '' : String(member.subJobId)))}><option value="">None</option>{member.subJobId !== null && !choices.jobs.some(job => job.id === member.subJobId) && <option value={member.subJobId}>Unknown class #{member.subJobId}</option>}{choices.jobs.map(job => <option key={job.id} value={job.id}>{job.name}</option>)}</select></Field></div><p className="save-editor__member-summary">{member.unlockedJobs} classes unlocked · {member.masteredJobs} mastered<br/>{member.learnedAbilities} abilities · {member.learnedPassives} passives learned</p><Button type="submit" tone="secondary" disabled={locked || !memberPending}>Apply member {member.index + 1}</Button></form>
        })}</div></section>}</div>
        <section className="save-editor__panel" aria-label="Money" id="save-editor-money"><h2>Money</h2><form className="save-editor__money" onSubmit={event => { event.preventDefault(); try { apply({ type: 'currency', value: wholeNumber(currencyInput, 'Copper') }, ['currency']) } catch (reason) { setError(errorMessage(reason)) } }}><Field label="Copper"><input id="save-editor-copper" aria-label="Copper" aria-describedby="save-editor-currency-preview save-editor-currency-limit" inputMode="numeric" aria-invalid={currencyInvalid || undefined} disabled={locked} value={currencyInput} onChange={event => setField('currency', event.target.value, String(summary.currency))}/></Field><Button type="submit" tone="secondary" disabled={locked || pending.currency === undefined}>Apply currency</Button><output id="save-editor-currency-preview" htmlFor="save-editor-copper" aria-label="In-game money preview">{currencyInvalid ? `Enter a whole number from 0 to ${SAVE_EDITOR_MAX_CURRENCY.toLocaleString()} copper.` : currencyDisplay(currencyValue)}</output><p className="field__hint" id="save-editor-currency-limit">Maximum {SAVE_EDITOR_MAX_CURRENCY.toLocaleString()} copper</p></form></section>
        {summary.editable && <section className="save-editor__panel" aria-label="Unlocks and presets" id="save-editor-presets"><h2>Unlocks and presets</h2><p>Review bulk changes before applying them.</p><div className="save-editor__bulk">{BULK_ACTIONS.map(action => <article key={action.type}><h3>{action.title}</h3><p>{action.description}</p><Button tone="secondary" disabled={locked || hasPending || partyDraftDirty} onClick={event => prepareReview(action, event.currentTarget)}>{action.button}</Button></article>)}</div></section>}
        <section className="save-editor__panel" aria-label="Inventory editor" id="save-editor-inventory"><h2>Inventory</h2><p>Edit carried stock, including items absent from the save. Equipment limits account for copies the party has equipped.</p><div className="save-editor__inventory-tools"><Field label="Search inventory"><input type="search" value={query} placeholder="Item name or ID" onChange={event => { setQuery(event.target.value); setInventoryLimit(INVENTORY_PAGE_SIZE) }}/></Field><Field label="Inventory category"><select value={inventoryKind} onChange={event => { setInventoryKind(event.target.value); setInventoryLimit(INVENTORY_PAGE_SIZE) }}><option value="all">All categories</option><option value="item">Items</option><option value="equipment">Equipment</option></select></Field><Field label="Stock filter"><select value={stockFilter} onChange={event => { setStockFilter(event.target.value); setInventoryLimit(INVENTORY_PAGE_SIZE) }}><option value="all">All stock</option><option value="carried">Carried stock only</option></select></Field></div><p className="save-editor__note" role="status">{inventory.length.toLocaleString()} matching entries</p><div className="save-editor__inventory-list">{inventory.slice(0, inventoryLimit).map(row => {
          const key = `stock.${row.kind}.${row.id}`
          return <form className="save-editor__inventory-row" key={key} onSubmit={event => { event.preventDefault(); try { apply({ type: 'stock', kind: row.kind, id: row.id, count: wholeNumber(pending[key] ?? String(row.count), `${row.name} stock`) }, [key]) } catch (reason) { setError(errorMessage(reason)) } }}><div><strong>{row.name}</strong><small>{row.kind === 'item' ? 'Item' : 'Equipment'} #{row.id} · stock limit {row.capacity}{row.equipped ? ` · ${row.equipped} equipped` : ''}</small></div><Field label="Stock"><input aria-label={`${row.name} stock`} inputMode="numeric" aria-invalid={invalidWholeNumber(pending[key]) || undefined} disabled={locked} value={pending[key] ?? String(row.count)} onChange={event => setField(key, event.target.value, String(row.count))}/></Field><Button aria-label={`Apply ${row.name} stock`} type="submit" tone="secondary" disabled={locked || pending[key] === undefined}>Apply</Button></form>
        })}</div>{!inventory.length && <p>No matching items. Try another name, ID, or filter.</p>}{inventory.length > inventoryLimit && <Button tone="secondary" onClick={() => setInventoryLimit(value => value + INVENTORY_PAGE_SIZE)}>Show more inventory ({inventory.length - inventoryLimit} remaining)</Button>}</section>
      </>}
      <p className="save-editor__note">This session lives in this tab. Editing uses {SAVE_EDITOR_RULES_LABEL} rules and matching mod definitions. The save format does not identify its game version or platform. Back up the original and close the game before replacing a save.</p>
    </>}
  </div>
}
