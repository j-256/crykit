import { Sources } from './Sources'
import { createId } from '../domain'
import { useCallback, useLayoutEffect, useRef, useState, type ChangeEvent } from 'react'
import type { LocalData, PlaythroughId, GameSetupRevisionId } from '../domain/types'
import { AppDataError, MAX_IMPORT_BYTES } from '../interchange'
import type { ImportCommitMode, ImportPreview } from '../interchange/types'
import { Button, DefinitionRow, Field, InlineNotice, Spinner } from './components'
import { Icon } from './icons'
import { downloadBytes, formatAppError, ownRecordValue } from './model'
import { useNavigation, useNavigationBlocker, type SettingsSection } from './navigation'
import { useNavigationNotice } from './useNavigationNotice'
import { Sheet } from './Sheet'
import { CreditsSection } from './CreditsSection'
import { GameSetupLibrary } from './GameSetupLibrary'
import { PlaythroughSettings } from './PlaythroughSettings'
import { APP_REFRESH_PENDING_MESSAGE, StorageSection } from './StorageSection'
import { GameSetupEditor, type GameSetupDraft, type GameSetupSaveOptions } from './GameSetupEditor'
import './tool-workflows.css'
import { HistoryEntries } from './HistoryEntries'
import { ErrorMessage } from './ErrorMessage'

const IMPORT_WARNING_PRIMARY_COUNT = 8
const IMPORT_WARNING_DOM_LIMIT = 100
const IMPORT_INFORMATION_CODES = new Set(['private-source', 'unreviewed-rights'])
function ImportPanel({ preview, importError, busy, disabled, onPreview, onCommit, onClear }: { preview?: ImportPreview; importError?: string; busy: boolean; disabled: boolean; onPreview: (bytes: Uint8Array, filename: string) => Promise<void>; onCommit: (preview: ImportPreview, mode: ImportCommitMode) => Promise<void>; onClear: () => void }) {
  const [mode, setMode] = useState<ImportCommitMode>(preview?.detectedFormat === 'crystal-edit-json-1' ? 'add-reference' : 'replace')
  const [replaceConfirmed, setReplaceConfirmed] = useState(false)
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
    // Notices about source handling stay available without competing with validation problems
    const actionableWarnings = displayedWarnings.filter(problem => !IMPORT_INFORMATION_CODES.has(problem.code))
    const primaryWarnings = actionableWarnings.slice(0, IMPORT_WARNING_PRIMARY_COUNT)
    const additionalWarnings = actionableWarnings.slice(IMPORT_WARNING_PRIMARY_COUNT)
    const sourceNotices = displayedWarnings.filter(problem => IMPORT_INFORMATION_CODES.has(problem.code))
    const omittedWarnings = preview.warnings.length - displayedWarnings.length
    return <div className="import-preview">
      {(importError || readError) && <InlineNotice title="Data operation could not be completed" tone="danger"><ErrorMessage message={(importError ?? readError)!}/> The preview and current planner data remain available.</InlineNotice>}
      <div className="split"><div><p className="eyebrow">Import preview</p><h3>{preview.filename}</h3></div><Button onClick={() => { setMode('replace'); setReplaceConfirmed(false); setReadError(undefined); onClear() }} tone="quiet">Choose another file</Button></div>
      <div aria-label="Records in this file" className="import-preview__counts"><div className="metric"><span className="metric__label">Reference records</span><span className="metric__value">{preview.counts.reference}</span><span className="metric__detail">Definitions and claims</span></div><div className="metric"><span className="metric__label">Personal records</span><span className="metric__value">{preview.counts.personal}</span><span className="metric__detail">Observations and plans</span></div></div>
      <Field label="Import action"><select onChange={(event) => { setMode(event.target.value as ImportCommitMode); setReplaceConfirmed(false) }} value={mode}>{preview.detectedFormat === 'crystal-edit-json-1' && <option value="add-reference">Add references to the shared library</option>}<option value="replace">Replace all planner data</option></select></Field>
      {mode === 'replace' ? <div className="import-preview__replacement"><InlineNotice title="Replace your planner data" tone="warning">All Playthroughs, Builds, Teams, Game Setups, and saved records will be replaced by this file. Export a backup first if you want to keep them.</InlineNotice><label className="check-row"><input checked={replaceConfirmed} onChange={(event) => setReplaceConfirmed(event.target.checked)} type="checkbox"/><span><strong>Replace all local planner data after validation</strong><small>Existing data stays unchanged if the transaction fails</small></span></label></div> : <p className="field__hint">Adds this catalog and its source file. Playthroughs, Builds, and Game Setups stay intact.</p>}
      {preview.errors.map(problem => <InlineNotice key={`${problem.code}:${problem.locator}`} title={problem.code} tone="danger">{problem.message}</InlineNotice>)}
      {primaryWarnings.map(problem => <InlineNotice key={`${problem.code}:${problem.locator}`} title={problem.code} tone="warning">{problem.message}</InlineNotice>)}
      {additionalWarnings.length > 0 && <details className="import-preview__warnings"><summary>{additionalWarnings.length} more import warnings</summary>{additionalWarnings.map(problem => <p key={`${problem.code}:${problem.locator}`}>{problem.message}</p>)}</details>}
      {omittedWarnings > 0 && <InlineNotice title="Additional warnings omitted" tone="warning">{omittedWarnings.toLocaleString()} additional warnings are not rendered in this preview.</InlineNotice>}
      <Button disabled={busy || disabled || preview.errors.length > 0 || (mode === 'replace' && !replaceConfirmed)} icon={mode === 'replace' ? 'warning' : 'check'} onClick={() => void onCommit(preview, mode)} tone={mode === 'replace' ? 'danger' : 'primary'}>{busy ? 'Importing...' : mode === 'add-reference' ? 'Add references' : 'Replace planner data'}</Button>
      <details className="import-preview__details"><summary>File details and source notices</summary><dl className="definition-list"><DefinitionRow term="Detected format">{preview.detectedFormat}</DefinitionRow><DefinitionRow term="Schema">{preview.detectedSchema}</DefinitionRow><DefinitionRow term="Suggested Playthrough label">{preview.localData.label}</DefinitionRow><DefinitionRow term="Data identity">{preview.localData.identity ?? 'No source identity'}</DefinitionRow></dl><Sources anchor={<h4>Source records</h4>} label="Sources for import"><dl className="definition-list"><DefinitionRow term="Source digest">{preview.sourceDigest}</DefinitionRow><DefinitionRow term="Catalog snapshots">{preview.proposed.catalogs.length}</DefinitionRow><DefinitionRow term="Evidence records">{preview.proposed.evidence.length}</DefinitionRow></dl></Sources>{sourceNotices.map(problem => <p key={`${problem.code}:${problem.locator}`}><strong>{problem.code}:</strong> {problem.message}</p>)}{preview.counts.ignored > 0 && <p>Ignored rows: {preview.counts.ignored}</p>}</details>
    </div>
  }
  return <div className="stack">{(importError || readError) && <InlineNotice title="Data operation could not be completed" tone="danger">{importError ?? readError} Your existing planner data has not been replaced.</InlineNotice>}<button className="import-zone" disabled={busy || disabled} onClick={() => inputRef.current?.click()} type="button">{busy ? <Spinner label="Reading import"/> : <><Icon name="upload"/><span><strong>Choose a JSON, ZIP, or workbook</strong><span>The file is validated and previewed before any write.</span></span></>}</button><input accept=".json,.zip,.xlsx,application/json,application/zip,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" aria-label="Choose import file" className="sr-only" onChange={(event) => void choose(event)} ref={inputRef} type="file"/><InlineNotice title="Private local import">Imported personal records and evidence stay in this browser. No file is uploaded.</InlineNotice></div>
}

export function DataPanel({ open, localData, preview, importError, busy, canUndo, dirty, saveError, onClose, onPreview, onCommit, onClearPreview, onExport, onSaveGameSetup, onRetrySave, onSelectGameSetup, onCreatePlaythrough, onSelectPlaythrough, onUndo }: { open: boolean; localData: LocalData; preview?: ImportPreview; importError?: string; busy: boolean; canUndo: boolean; dirty: boolean; saveError?: string; onClose: () => void; onPreview: (bytes: Uint8Array, filename: string) => Promise<void>; onCommit: (preview: ImportPreview, mode: ImportCommitMode) => Promise<void>; onClearPreview: () => void; onExport: () => Promise<Uint8Array>; onSaveGameSetup: (draft: GameSetupDraft, options: GameSetupSaveOptions) => Promise<void>; onRetrySave: () => Promise<void>; onSelectGameSetup: (revisionId: GameSetupRevisionId) => Promise<void>; onCreatePlaythrough: (label: string, setupId?: GameSetupRevisionId) => Promise<void>; onSelectPlaythrough: (playthroughId: PlaythroughId) => Promise<void>; onUndo: () => Promise<void> }) {
  const navigation = useNavigation()
  const settingsPage = navigation.route.page.page === 'settings' ? navigation.route.page : undefined
  const section = settingsPage?.section ?? 'data'
  const requestedPreviewId = settingsPage && 'previewId' in settingsPage ? settingsPage.previewId : undefined
  const activePreview = requestedPreviewId !== undefined && preview?.id === requestedPreviewId ? preview : undefined
  const missingPreview = requestedPreviewId !== undefined && !activePreview
  const newGameSetup = navigation.route.query.new?.[0] === 'true'
  const requestedGameSetupId = navigation.route.query.gameSetup?.[0]
  const requestedGameSetup = requestedGameSetupId ? ownRecordValue(localData.gameSetups, requestedGameSetupId) : undefined
  const gameSetupFocus = navigation.route.query.focus?.[0]
  const focus = gameSetupFocus === 'setup' || gameSetupFocus === 'passives' || gameSetupFocus === 'slots' ? gameSetupFocus : undefined
  const editingSetup = section === 'game-setup' && (newGameSetup || !!requestedGameSetupId)
  const pendingSetupId = useRef<GameSetupRevisionId | undefined>(undefined)
  const sectionNavigationRef = useRef<HTMLDivElement>(null)
  const [panelError, setPanelError] = useState<string>()
  const panelNotice = useNavigationNotice()
  const closeNotice = useNavigationNotice()
  const [panelDirty, setPanelDirty] = useState(false)
  const panelDirtyRef = useRef(false)
  const storageReloadingRef = useRef(false)
  const setStorageReloading = useCallback((value: boolean) => { storageReloadingRef.current = value }, [])
  const [dataBusy, setDataBusy] = useState(false)
  const [undoConfirmed, setUndoConfirmed] = useState(false)
  const [closeRequested, setCloseRequested] = useState(false)
  const [setupFooter, setSetupFooter] = useState<HTMLDivElement | null>(null)
  useLayoutEffect(() => { const body = sectionNavigationRef.current?.closest('.sheet__body'); if (body) body.scrollTop = 0 }, [section, requestedGameSetupId, newGameSetup])
  const blocked = dirty || panelDirty
  const setGameSetupDirty = useCallback((value: boolean) => { panelDirtyRef.current = value; setPanelDirty(value); if (!value) { setPanelError(undefined); setCloseRequested(false) } }, [])
  const warnBeforeLeavingSetup = () => { setPanelError('Save or discard your Game Setup changes before leaving this editor.'); if (closeRequested) closeNotice.revealNotice(); else panelNotice.revealNotice() }
  useNavigationBlocker(navigation.route, () => panelDirtyRef.current, warnBeforeLeavingSetup, undefined, true)
  const changeSection = (next: SettingsSection) => {
    if (panelDirty) {
      warnBeforeLeavingSetup()
      return
    }
    setPanelError(undefined)
    navigation.navigate({ page: { page: 'settings', section: next }, overlays: [], query: {} })
  }
  const exportBackupNow = async () => {
    setPanelError(undefined)
    try { downloadBytes(await onExport(), 'crykit-backup.zip', 'application/zip') } catch (reason) { setPanelError(formatAppError(reason, 'The backup could not be prepared.')) }
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
    setCloseRequested(false)
    onClose()
  }
  const clearPreview = () => {
    onClearPreview()
  }
  const finishSetupSave = () => {
    setGameSetupDirty(false)
    navigation.navigate({ page: { page: 'settings', section: 'game-setup' }, overlays: [], query: { gameSetup: [pendingSetupId.current!] } }, { replace: true })
  }
  const saveGameSetup = async (draft: GameSetupDraft) => {
    const id = createId<GameSetupRevisionId>('gameSetupRevision')
    pendingSetupId.current = id
    await onSaveGameSetup(draft, { id })
    finishSetupSave()
  }
  return <Sheet footer={editingSetup ? <div className="game-setup-footer">{closeRequested && <div aria-label="Game Setup close choices" ref={closeNotice.noticeRef} role="region" tabIndex={-1}><div className="game-setup-discard" role="alert"><p>Discard your unsaved Game Setup changes and close?</p><div className="cluster"><Button onClick={close} tone="danger">Discard and close</Button><Button onClick={() => setCloseRequested(false)} tone="secondary">Keep editing</Button></div></div></div>}<div aria-label="Game Setup navigation warning" hidden={closeRequested} ref={panelNotice.noticeRef} role="region" tabIndex={-1}>{panelError && <InlineNotice title="Unsaved Game Setup fields" tone="warning">{panelError}</InlineNotice>}<div ref={setSetupFooter}/></div></div> : undefined} onRequestClose={() => { if (storageReloadingRef.current) { setPanelError(APP_REFRESH_PENDING_MESSAGE); panelNotice.revealNotice(); return false } if (panelDirtyRef.current && !(dirty && saveError)) { setCloseRequested(true); closeNotice.revealNotice(); return false } return true }} onClose={close} open={open} title="Data & settings" width="wide">
    <div className="data-nav" ref={sectionNavigationRef} role="group" aria-label="Data and settings sections">{([{ id: 'playthrough', label: 'Playthrough' }, { id: 'game-setup', label: 'Saved setups' }, { id: 'data', label: 'Import & backup' }, { id: 'history', label: 'History' }, { id: 'storage', label: 'Offline & storage' }, { id: 'credits', label: 'Credits & licenses' }] as const).map((item) => <button aria-pressed={section === item.id} key={item.id} onClick={() => changeSection(item.id)} type="button">{item.label}</button>)}</div>

    {panelError && section !== 'game-setup' && <div aria-label="Data navigation warning" ref={panelNotice.noticeRef} role="region" tabIndex={-1}><InlineNotice title={panelError === APP_REFRESH_PENDING_MESSAGE ? 'App refresh is still in progress' : 'Data operation could not be completed'} tone={panelError === APP_REFRESH_PENDING_MESSAGE ? 'warning' : 'danger'}>{panelError}</InlineNotice></div>}
    {section === 'playthrough' && <>{dirty && saveError && <InlineNotice title="Playthrough settings not saved" tone="danger">{saveError}<Button disabled={dataBusy} onClick={() => void runDataAction(onRetrySave)} tone="secondary">Retry save</Button></InlineNotice>}<PlaythroughSettings disabled={blocked || busy || dataBusy} localData={localData} onApply={onSelectGameSetup} onCreate={onCreatePlaythrough} onSelect={onSelectPlaythrough} run={runDataAction}/></>}
    {section === 'data' && <div className="stack">
      {!activePreview && <section className="settings-section"><div className="split"><div><h3>Track a new game save</h3><p className="settings-section__intro">Create a blank Playthrough for your characters and progress. Builds and Teams stay in your shared planning library; use Show sample Builds to hide examples.</p></div><Button disabled={blocked || busy || dataBusy} icon="plus" onClick={() => navigation.navigate({ page: { page: 'settings', section: 'playthrough' }, overlays: [], query: { create: ['true'] } })} tone="secondary">New blank Playthrough</Button></div></section>}
      <section className="settings-section"><h3>Import or restore</h3><p className="settings-section__intro">Crystal Edit JSON, research files, and backups are parsed locally and previewed before saving.</p>{missingPreview && <InlineNotice title="Import preview expired" tone="warning">This address identifies a file preview that is no longer held in memory. Choose the source file again to create a fresh dry-run preview; no planner data was changed.</InlineNotice>}<ImportPanel busy={busy} disabled={blocked || dataBusy} importError={importError} key={JSON.stringify([localData.id, activePreview?.id ?? null])} onClear={clearPreview} onCommit={onCommit} onPreview={onPreview} preview={activePreview}/></section>
      <section className="settings-section"><div className="split"><div><h3>Complete planner backup</h3><p className="settings-section__intro">Download your saved planner data and any retained failed-save changes. Submit open form fields first.</p></div><Button disabled={busy || dataBusy} icon="download" onClick={() => void exportBackupNow()} tone="secondary">Export backup</Button></div><details className="import-preview__details"><summary>What's included in a backup?</summary><p>All Playthroughs, Game Setups, Builds, Teams, saved records, and any retained failed-save transaction. Mod Inspector originals and drafts, and game saves opened in Save Editor, have separate downloads.</p></details></section>
    </div>}
    {section === 'game-setup' && <>
      {panelError && !editingSetup && <div aria-label="Game Setup navigation warning" ref={panelNotice.noticeRef} role="region" tabIndex={-1}><InlineNotice title="Unsaved Game Setup fields" tone="warning">{panelError}</InlineNotice></div>}
      {!editingSetup ? <GameSetupLibrary localData={localData}/> : requestedGameSetupId && !requestedGameSetup ? <InlineNotice title="Requested Game Setup unavailable" tone="warning">This saved revision is unavailable. <Button icon="arrow-left" onClick={() => changeSection('game-setup')} tone="quiet">Back to saved setups</Button></InlineNotice> : <>
        <Button className="settings-back" disabled={panelDirty} icon="arrow-left" onClick={() => changeSection('game-setup')} tone="quiet">Back to saved setups</Button>
        <GameSetupEditor footer={setupFooter} blocked={busy || !!(dirty && saveError)} current={newGameSetup ? undefined : requestedGameSetup} focus={focus} key={`${localData.id}:${newGameSetup ? 'new' : requestedGameSetup?.id ?? 'new'}`} onDirty={setGameSetupDirty} onSubmit={saveGameSetup} onRetry={async () => { await onRetrySave(); finishSetupSave() }} localData={localData} saveError={dirty ? saveError : undefined}/>
      </>}
    </>}

    {section === 'history' && <div className="stack"><section className="settings-section"><div className="split"><div><h3>Undo latest saved change</h3><p className="settings-section__intro">Undo restores the previous saved state and records the change in History.</p></div><Button disabled={blocked || busy || dataBusy || !canUndo || !undoConfirmed} icon="history" onClick={() => void runDataAction(async () => { await onUndo(); setUndoConfirmed(false) })} tone="secondary">Undo latest</Button></div><label className="check-row"><input checked={undoConfirmed} disabled={blocked || busy || dataBusy || !canUndo} onChange={(event) => setUndoConfirmed(event.target.checked)} type="checkbox"/><span><strong>Restore the previous saved planner state</strong><small>{canUndo ? 'The restored state is recorded as a new revision' : 'No retained local checkpoint is available for this revision'}</small></span></label></section><HistoryEntries changes={localData.changes}/></div>}
    {section === 'storage' && <StorageSection dirty={blocked} saving={busy || dataBusy} onExport={onExport} onReloadingChange={setStorageReloading} localData={localData} saveError={saveError}/>}
    {section === 'credits' && <CreditsSection/>}
  </Sheet>
}
