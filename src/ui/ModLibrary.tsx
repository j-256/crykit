import { Sources } from './Sources'
import { projectModAvailability } from '../catalog/mods'
import { modState, modListPriority } from '../domain/mods'
import { ModStateBadge } from './DefinitionModLabel'
import { modIsInReference } from '../domain/reference-library'
import { useEffect, useMemo, useRef, useState } from 'react'
import { bundledModDefinitionCount, type BundledLibraryMod, type ModLibraryCard, type ModRevision } from '../domain/mod-library'
import { bundledModEditableSource } from '../catalog/mod-library'
import type { CatalogId } from '../domain/types'
import { Badge, Button, Field, InlineNotice } from './components'
import { useDefinitionLibrary } from './definitions'
import { useNavigation } from './navigation'
import type { SaveModToLibrary } from './ModInspectorView'
import { readModFile } from './mod-inspector/import-file'
import { buildModLibraryCards } from './mod-library-data'
import { CRYSTAL_PROJECT_WORKSHOP_URL, steamWorkshopItemUrl } from '../domain/mod-workshop'
import './mod-library.css'
import { formatAppError } from './model'

export type SetModReference = (modId: string, included: boolean) => Promise<void>

type ReferenceFeedback = { readonly cardId: string; readonly included: boolean } & (
  { readonly status: 'failed'; readonly message: string } |
  { readonly status: 'saved'; readonly warnings: readonly string[] }
)

function SavedRevision({ revision, busy, onEdit }: { readonly revision: ModRevision; readonly busy: boolean; readonly onEdit: (revision: ModRevision) => void }) {
  return <div className="split mod-library__revision">
    <div><Badge>Saved version</Badge><strong>{revision.declaredVersion ? `Version ${revision.declaredVersion}` : 'Version unspecified'}</strong><p>{Object.keys(revision.catalog.entities).length} catalog definitions</p><Sources label={`Sources for saved ${revision.title} version ${revision.declaredVersion ?? 'unspecified'}`}><p>Source {revision.sourceDigest} · Editor format {revision.editorVersion ?? 'unknown'}</p></Sources></div>
    <Button disabled={busy} onClick={() => onEdit(revision)} tone="secondary">Edit this version</Button>
  </div>
}

function ModCard({ card, busy, referenceFeedback, onBrowse, onToggleReference, onEdit, onEditBundled, onImport }: { readonly card: ModLibraryCard; readonly busy: boolean; readonly referenceFeedback?: ReferenceFeedback; readonly onBrowse: () => void; readonly onToggleReference: (included?: boolean) => void; readonly onEdit: (revision: ModRevision) => void; readonly onEditBundled: (mod: BundledLibraryMod) => void; readonly onImport: (file: File, catalogId: CatalogId) => void }) {
  const navigation = useNavigation()
  const input = useRef<HTMLInputElement>(null)
  const feedbackRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const feedback = feedbackRef.current
    if (!referenceFeedback || !feedback) return
    const saveAlert = document.querySelector<HTMLElement>('.global-save-alert')
    const reveal = () => {
      feedback.style.setProperty('--reference-feedback-alert-height', `${saveAlert?.getBoundingClientRect().height ?? 0}px`)
      feedback.scrollIntoView({ block: 'nearest', behavior: 'instant' })
    }
    reveal()
    if (!saveAlert) return
    const observer = new ResizeObserver(reveal)
    observer.observe(saveAlert)
    return () => observer.disconnect()
  }, [referenceFeedback])
  const mod = card.project
  const saved = mod?.revisions[0]
  const bundled = mod?.bundled[0]
  const sourceCount = bundled ? bundledModDefinitionCount(bundled) : 0
  const unloadedSource = !saved && sourceCount > 0
  const bundledSource = Boolean(bundled && (!saved || mod?.bundled.some(source => source.sourceDigest === saved.sourceDigest)))
  const workshop = steamWorkshopItemUrl(mod?.revisions.find(revision => revision.steamWorkshopFileId)?.steamWorkshopFileId ?? mod?.bundled.find(revision => revision.steamWorkshopFileId)?.steamWorkshopFileId)
  const version = saved?.declaredVersion ?? bundled?.declaredVersion
  const sourceName = card.catalogNames[0] ?? card.title
  const { localData } = useDefinitionLibrary()
  const setup = localData.planningGameSetupRevisionId ? localData.gameSetups[localData.planningGameSetupRevisionId] : undefined
  const availability = mod ? projectModAvailability(mod.id, card.title, setup) : { requiredMod: card.title, state: modState(setup, sourceName) }
  const inReference = modIsInReference(localData, card)
  return <section aria-label={card.title} data-mod-state={availability.state} className="panel mod-library__card"><div className="panel__body stack">
    <div className="split"><h3>{card.title}</h3><Badge tone={mod ? 'info' : 'neutral'}>{bundledSource ? 'Bundled JSON' : saved ? 'Imported JSON' : 'Mod JSON unavailable'}</Badge></div>
    <div><ModStateBadge state={availability.state}/></div>
    <p className="mod-library__summary">{unloadedSource ? <>{sourceCount} definitions in bundled JSON{card.entryCount > 0 && ` · ${card.entryCount} existing catalog ${card.entryCount === 1 ? 'entry' : 'entries'}`}</> : card.entryCount ? `${card.entryCount} catalog ${card.entryCount === 1 ? 'entry' : 'entries'}` : 'No catalog entries yet'}{mod && ` · ${version ? `Version ${version}` : 'Version unspecified'}`}</p>
    {!mod && <p className="field__hint">Add items, classes, or skills from what you see in-game. Missing facts can stay unknown.</p>}
    <div className="cluster mod-library__actions">
      <Button disabled={(!card.entryCount && !unloadedSource) || busy} onClick={onBrowse} tone="secondary">View catalog entries</Button>
      <Button aria-pressed={inReference} disabled={(!card.entryCount && !unloadedSource) || busy} onClick={() => onToggleReference()} tone="secondary" icon={inReference ? 'close' : 'plus'}>{inReference ? 'Remove from Reference' : 'Add to Reference'}</Button>
      <Button disabled={busy} onClick={() => navigation.navigate({ page: { page: 'mods', view: 'library' }, overlays: [{ kind: 'definition-editor', mode: 'new' }], query: { mod: [sourceName], ...(mod ? { 'mod-project': [mod.id] } : {}) } })} tone="secondary" icon="plus">Add catalog entry</Button>
      {mod && <><Button disabled={busy} onClick={() => saved ? onEdit(saved) : bundled && onEditBundled(bundled)} tone="secondary" icon="edit">Edit mod JSON</Button><Button disabled={busy} onClick={() => input.current?.click()} tone="secondary" icon="upload">Import updated version</Button><input ref={input} type="file" accept=".json,application/json" className="sr-only" aria-label={`Updated JSON for ${card.title}`} disabled={busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) onImport(file, mod.id) }}/></>}
    </div>
    {referenceFeedback && <div className="mod-library__feedback" ref={feedbackRef}>{referenceFeedback.status === 'failed'
      ? <InlineNotice title="Reference not changed" tone="danger"><p>{referenceFeedback.message}</p><p>Your previous Reference membership is unchanged.</p><Button disabled={busy} onClick={() => onToggleReference(referenceFeedback.included)} tone="secondary" type="button">Retry Reference change</Button></InlineNotice>
      : <InlineNotice title={referenceFeedback.included ? 'Added to Reference' : 'Removed from Reference'} tone="positive"><p>{referenceFeedback.included ? 'These entries are included in Reference.' : 'These entries are hidden from Reference. Saved builds and mod settings are kept.'}</p>{referenceFeedback.warnings.length > 0 && <details><summary>Import notes</summary><ul>{referenceFeedback.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}</InlineNotice>}</div>}
    {workshop && <a href={workshop} target="_blank" rel="noopener noreferrer" aria-label={`View ${card.title} on Steam Workshop`}>View on Steam Workshop</a>}
    {mod && <details className="mod-library__versions"><summary>Versions</summary><div className="stack">
      <p className="field__hint">Choose a version in Game Setup to use its supported definitions and settings. Existing builds keep their selected versions. Custom artwork files are separate from the JSON.</p>
      {mod.revisions.map(revision => <SavedRevision key={revision.catalogRevisionId} revision={revision} busy={busy} onEdit={onEdit}/>)}
      {mod.bundled.map(source => <div className="split mod-library__revision" key={source.sourceDigest}><div><Badge tone="info">Bundled version</Badge><strong>{source.declaredVersion ? `Version ${source.declaredVersion}` : 'Version unspecified'}</strong><p>{bundledModDefinitionCount(source)} supported model records · Full project JSON</p><Sources label={`Sources for bundled ${source.title} version ${source.declaredVersion ?? 'unspecified'}`}><p>Source {source.sourceDigest} · Editor format {source.editorVersion}</p></Sources></div><Button disabled={busy} onClick={() => onEditBundled(source)} tone="secondary">Edit bundled copy</Button></div>)}
    </div></details>}
  </div></section>
}

export function ModLibrary({ onOpenEditor, onEdit, onEditBundled, onImport, onSetReference }: { readonly onOpenEditor: () => void; readonly onEdit: (revision: ModRevision) => Promise<void>; readonly onEditBundled: (mod: BundledLibraryMod) => Promise<void>; readonly onImport: SaveModToLibrary; readonly onSetReference: SetModReference }) {
  const library = useDefinitionLibrary()
  const catalogs = library.catalogs
  const cards = useMemo(() => buildModLibraryCards(catalogs, library.options, library.localData), [catalogs, library.options, library.localData])
  const navigation = useNavigation()
  const input = useRef<HTMLInputElement>(null)
  const [pending, setPending] = useState<string>()
  const [error, setError] = useState<string>()
  const [referenceFeedback, setReferenceFeedback] = useState<ReferenceFeedback>()
  const [result, setResult] = useState<Awaited<ReturnType<SaveModToLibrary>>>()
  const [query, setQuery] = useState('')
  const busy = Boolean(pending)
  const toggleReference = async (card: ModLibraryCard, included = !modIsInReference(library.localData, card)) => {
    setPending(included ? 'Adding mod to Reference...' : 'Removing mod from Reference...'); setError(undefined); setReferenceFeedback(undefined); setResult(undefined)
    try {
      const mod = card.project
      const bundled = mod?.bundled[0]
      let warnings: readonly string[] = []
      if (!included || card.entryCount > 0) await onSetReference(card.id, included)
      else if (bundled && mod && !mod.revisions.length) {
        const source = await bundledModEditableSource(bundled)
        warnings = (await onImport(source.text, source.filename, mod.id, true)).warnings
      }
      setReferenceFeedback({ cardId: card.id, included, status: 'saved', warnings })
    } catch (reason) { setReferenceFeedback({ cardId: card.id, included, status: 'failed', message: formatAppError(reason, 'Reference membership could not be changed.') }) }
    finally { setPending(undefined) }
  }
  const edit = async (open: () => Promise<void>) => {
    setPending('Opening mod JSON...'); setError(undefined); setResult(undefined)
    try { await open() } catch (reason) { setError(reason instanceof Error ? reason.message : 'The mod revision could not be opened.') }
    finally { setPending(undefined) }
  }
  const importFile = async (file: File, catalogId?: CatalogId) => {
    setPending('Importing mod...'); setError(undefined); setResult(undefined)
    try { setResult(await onImport(await readModFile(file), file.name, catalogId)) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'The mod revision could not be imported.') }
    finally { setPending(undefined) }
  }
  const search = query.trim().toLocaleLowerCase()
  const setup = library.localData.planningGameSetupRevisionId ? library.localData.gameSetups[library.localData.planningGameSetupRevisionId] : undefined
  const cardPriority = (card: ModLibraryCard) => modListPriority(card.project ? projectModAvailability(card.project.id, card.title, setup) : { requiredMod: card.title, state: modState(setup, card.catalogNames[0] ?? card.title) })
  const visible = cards.filter(card => [card.title, card.id, ...card.catalogNames].some(value => value.toLocaleLowerCase().includes(search))).sort((a, b) => cardPriority(a) - cardPriority(b))
  return <div className="stack mod-library">
    <div className="split mod-library__header"><h2>Mod library</h2><div className="cluster"><Button disabled={busy} onClick={() => input.current?.click()} icon="upload">Import mod</Button><Button disabled={busy} onClick={onOpenEditor} tone="secondary">Open mod editor</Button><Button disabled={busy} onClick={() => navigation.navigate({ page: { page: 'settings', section: 'game-setup' }, overlays: [], query: {} })} tone="secondary">Game Setups</Button></div></div>
    <input ref={input} type="file" accept=".json,application/json" className="sr-only" aria-label="Import mod JSON" disabled={busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importFile(file) }}/>
    <p>Find published mods and updates on <a href={CRYSTAL_PROJECT_WORKSHOP_URL} target="_blank" rel="noopener noreferrer" aria-label="Browse Crystal Project's Steam Workshop">Crystal Project's Steam Workshop</a>.</p>
    <p className="field__hint">Reference starts with vanilla and the Switch mod packs. Add or remove mod catalogs with the Reference toggle, or view one temporarily. This does not change game enablement or saved builds. Enabled mods appear first; other mods remain discoverable below.</p>
    <Field label="Search mods"><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Mod name or project ID"/></Field>
    {pending && <p role="status">{pending}</p>}
    {error && <InlineNotice title="Mod operation failed" tone="danger">{error}</InlineNotice>}
    {result && <InlineNotice title={result.unchanged ? 'This mod revision is already saved' : 'Mod revision saved to CryKit'} tone="positive"><p>{result.title}. Select this version in a Game Setup to use it.</p>{result.warnings.length > 0 && <details><summary>Import notes</summary><ul>{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}</InlineNotice>}
    {visible.map(card => <ModCard key={card.id} card={card} busy={busy} referenceFeedback={referenceFeedback?.cardId === card.id ? referenceFeedback : undefined} onBrowse={() => navigation.navigate({ page: { page: 'reference', view: 'list' }, overlays: [], query: { 'library-mod': [card.id], audience: ['alternatives'] } })} onToggleReference={included => void toggleReference(card, included)} onEdit={revision => void edit(() => onEdit(revision))} onEditBundled={source => void edit(() => onEditBundled(source))} onImport={(file, catalogId) => void importFile(file, catalogId)}/>)}
    {!visible.length && <p>No mods match this search.</p>}
  </div>
}
