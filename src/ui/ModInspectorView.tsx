import { assertActiveProfile, trackProfileUrl, type ProfileToken } from '../account/profile'
import { encodeEditorText } from '../workspace/editor-document'
import { useEditorStorage, inspectorDraft } from './mod-inspector/useEditorStorage'
import { useWorkspace } from './WorkspaceProvider'
import { Sources } from './Sources'
import { lazy, memo, Suspense, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { childAt, childCount, parseDocument, parseJsonFragment, nodeAtPath, formatJsonPath, objectProperty } from '../mod-inspector/document'
import { diffDocuments } from '../mod-inspector/diff'
import { createResolver, getEnumCatalog, INSPECTOR_REFERENCE_ID } from '../mod-inspector/reference'
import { summarizeInspectorDraft } from '../mod-inspector/storage'
import { deriveInspectorFileInfo } from '../mod-inspector/file-info'
import { newMapProject } from '../mod-inspector/map-editor'
import type { DocumentChange, InspectorDraft, InspectorDraftSummary, InspectorRelationship, InspectorResolver, JsonNode, JsonPath, ParsedDocument } from '../mod-inspector/types'
import { Button, Field, InlineNotice, ScreenHeader } from './components'
import type { DraftActions, DraftChangeHandler } from './drafts'
import type { CatalogId } from '../domain/types'
import { readModFile } from './mod-inspector/import-file'
import { createSearchScheduler } from './mod-inspector/search-scheduler'
import type { ModEditorView } from './mod-workspace'
import { ModWorkspaceNavigation } from './ModWorkspaceNavigation'
import { isExpanded, prepareVisibleTree, revealPath, setExpansion, type ExpansionRule, type VisibleTreeRow } from './mod-inspector/tree'
import './mod-inspector/inspector.css'

export type SaveModToLibrary = (text: string, filename: string, expectedCatalogId?: CatalogId, includeInReference?: boolean, futureDefault?: boolean, editorOwner?: symbol) => Promise<{ readonly title: string; readonly unchanged: boolean; readonly warnings: readonly string[] }>

// Coalesce typing bursts while leaving time for encrypted persistence and the next input
const EDITOR_QUIET_MS = 350
const DOWNLOAD_URL_LIFETIME_MS = 1000
const PAGE_SIZE = 80
const TREE_ROW_PAGE_SIZE = 240
const INITIAL_EXPANSION: readonly ExpansionRule[] = [{ path: [], open: true }]
const SHORT_DRAFT_ID_LENGTH = 8
const METADATA_PREVIEW_LENGTH = 80
const SEARCH_SLICE_MS = 8
const SEARCH_SLICE_NODE_LIMIT = 2000
const SEARCH_PROGRESS_INTERVAL_MS = 100
const SEARCH_TIME_CHECK_INTERVAL = 32
const SEARCH_DEBOUNCE_MS = 150
const MapPlacementEditor = lazy(() => import('./mod-inspector/MapPlacementEditor'))
type InspectorTab = ModEditorView
const pathKey = (path: JsonPath) => JSON.stringify(path)
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
function fileLabel(row: InspectorDraftSummary) {
  return [row.fileInfo?.title, row.fileInfo?.version ? `Version ${row.fileInfo.version}` : undefined, row.filename, row.fileInfo?.edited ? 'Edited copy' : undefined].filter(Boolean).join(' · ')
}
function metadataPreview(node: JsonNode | undefined) {
  if (!node) return '(absent)'
  if (node.kind === 'object' || node.kind === 'array') return `(${node.kind} value)`
  return node.raw.length > METADATA_PREVIEW_LENGTH ? `${node.raw.slice(0, METADATA_PREVIEW_LENGTH)}...` : node.raw
}
function initiateDownload(filename: string, body: string | Uint8Array, type: string, assertCurrent: () => void, token?: ProfileToken) {
  assertCurrent()
  if (token) assertActiveProfile(token)
  const url = URL.createObjectURL(new Blob([typeof body === 'string' ? body : new Uint8Array(body)], { type }))
  try {
    // Private URLs belong to the captured profile even after the anchor starts the browser request
    if (token) trackProfileUrl(token, url)
    assertCurrent()
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_LIFETIME_MS)
  } catch (error) {
    URL.revokeObjectURL(url)
    throw error
  }
}
function hasUnpairedSurrogate(text: string) {
  // Blob(string) replaces lone surrogates; reject that conversion without rewriting the JSON source
  for (const point of text) { const code = point.codePointAt(0)!; if (code >= 0xd800 && code <= 0xdfff) return true }
  return false
}

function JsonTreeRow({ row, resolver, selected, onExpand, onSelect, onMore }: { row: VisibleTreeRow; resolver: InspectorResolver; selected: string; onExpand: (path: JsonPath, recursive: boolean) => void; onSelect: (path: JsonPath) => void; onMore: (path: JsonPath) => void }) {
  const node = row.node
  if (row.kind === 'more') return <li className="inspector-tree-more" style={{ paddingLeft: (node.path.length + 1) * 14 }}><Button tone="quiet" onClick={() => onMore(node.path)}>Show more children ({row.remaining} remaining)</Button></li>
  const key = pathKey(node.path)
  const container = node.kind === 'array' || node.kind === 'object'
  const annotation = resolver.annotate(node.path)
  const label = node.path.length === 0 ? 'Document' : String(node.path.at(-1))
  const record = node.kind === 'object' && typeof node.path.at(-1) === 'number'
  const name = record ? objectProperty(node, 'Name') : undefined
  const id = record ? objectProperty(node, 'ID') : undefined
  const recordName = name?.kind === 'string' ? String(name.value) : undefined
  const recordId = id && (id.kind === 'number' || id.kind === 'string') ? id.raw : undefined
  return <li className="inspector-tree-node" style={{ paddingLeft: node.path.length * 14 }}>
    <div className={`inspector-tree-row ${selected === key ? 'is-selected' : ''}`}>
      {container ? <button type="button" className="inspector-expander" aria-label={`${row.open ? 'Collapse' : 'Expand'} ${formatJsonPath(node.path)}`} title={`Alt-click to ${row.open ? 'collapse' : 'expand'} this entire branch`} aria-expanded={row.open} onClick={event => onExpand(node.path, event.altKey)}>{row.open ? '-' : '+'}</button> : <span className="inspector-expander"/>}
      <button type="button" className="inspector-node-button" aria-label={`Select ${formatJsonPath(node.path)}${recordName ? `: ${recordName}` : ''}${recordId ? `, ID ${recordId}` : ''}`} onClick={() => onSelect(node.path)} title={formatJsonPath(node.path)}><strong>{label}</strong>{recordName && <span className="inspector-record-name">{recordName}</span>}{recordId !== undefined && <code className="inspector-record-id">ID {recordId}</code>}<code className={`inspector-value inspector-value--${node.kind}`}>{container ? `${node.kind === 'object' ? '{' : '['}${childCount(node)}${node.kind === 'object' ? '}' : ']'}` : node.raw}</code>{annotation && <span className={`inspector-annotation inspector-annotation--${annotation.status}`}>{annotation.label}</span>}</button>
    </div>
  </li>
}

function ReviewChange({ change, resolver, originalResolver }: { change: DocumentChange; resolver: InspectorResolver; originalResolver?: InspectorResolver }) {
  const container = change.before?.kind === 'object' || change.before?.kind === 'array' || change.after?.kind === 'object' || change.after?.kind === 'array'
  const [open, setOpen] = useState(!container)
  const beforeLabel = change.before ? originalResolver?.annotate(change.beforePath ?? change.path)?.label : undefined
  const afterLabel = change.after ? resolver.annotate(change.path)?.label : undefined
  return <details className="inspector-change" open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary><strong>{change.kind}</strong> <code>{formatJsonPath(change.path)}</code> {afterLabel ?? beforeLabel}{change.kind === 'moved' && change.beforePath && <span>{pathKey(change.beforePath) === pathKey(change.path) ? ' (relative order changed)' : ` from ${formatJsonPath(change.beforePath)}`}</span>}</summary>{open && <div className="inspector-change-values"><div><strong>Before {beforeLabel}</strong><pre>{change.before?.raw ?? '(absent)'}</pre></div><div><strong>After {afterLabel}</strong><pre>{change.after?.raw ?? '(absent)'}</pre></div></div>}</details>
}

const EnumDictionary = memo(function EnumDictionary() {
  const [query, setQuery] = useState('')
  const catalog = useMemo(getEnumCatalog, [])
  const normalized = query.trim().toLowerCase()
  const hasMatches = catalog.some(group => group.entries.some(option => `${group.name} ${option.value} ${option.label}`.toLowerCase().includes(normalized)))
  return <section className="inspector-panel inspector-dictionary"><h2>Exact enum names</h2><p>Search enum names or numbers without opening a mod.</p><Field label="Search enum names and values"><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Name, value, or enum family"/></Field><div className="inspector-enum-groups">{catalog.map(group => {
    const entries = group.entries.filter(option => `${group.name} ${option.value} ${option.label}`.toLowerCase().includes(normalized))
    if (!entries.length) return null
    return <details key={group.name} open={normalized ? true : undefined}><summary>{group.name} <small>({entries.length})</small></summary><dl>{entries.map(option => <div key={option.value}><dt><code>{option.value}</code></dt><dd>{option.label}</dd></div>)}</dl></details>
  })}</div>{!hasMatches && <p role="status">No enum names or values match this search. Try a shorter name, numeric value, or enum family.</p>}</section>
})

function EditorWorkspaceView({ onDraftChange, onSaveToLibrary, initialDraftId, embedded = false, view, onViewChange, navigationId, openSource, onOpenSourceFinished }: { readonly onDraftChange?: DraftChangeHandler; readonly onSaveToLibrary?: SaveModToLibrary; readonly initialDraftId?: string; readonly embedded?: boolean; readonly view?: ModEditorView; readonly onViewChange?: (view: ModEditorView) => void; readonly navigationId?: string; readonly openSource?: { readonly filename: string; readonly bytes: Uint8Array; readonly text: string }; readonly onOpenSourceFinished?: () => void } = {}) {
  const [libraryResult, setLibraryResult] = useState<Awaited<ReturnType<SaveModToLibrary>>>()
  const [libraryError, setLibraryError] = useState<string>()
  const { repository, token } = useWorkspace()
  const storage = useEditorStorage()
  const controller = storage.controller
  const viewOwner = storage.view
  const [drafts, setDrafts] = useState<readonly InspectorDraftSummary[]>([])
  const draftLabels = useMemo(() => {
    const counts = new Map<string, number>()
    drafts.forEach(row => { const label = fileLabel(row); counts.set(label, (counts.get(label) ?? 0) + 1) })
    return new Map(drafts.map(row => {
      const date = new Date(row.createdAt)
      const importedAt = Number.isNaN(date.getTime()) ? 'Import date unavailable' : date.toLocaleString()
      const label = fileLabel(row)
      return [row.id, counts.get(label) === 1 ? label : `${label} | ${importedAt} | ${row.id.slice(-SHORT_DRAFT_ID_LENGTH)}`]
    }))
  }, [drafts])
  const [active, setActive] = useState<InspectorDraft>()
  const activeRef = useRef<InspectorDraft | undefined>(undefined)
  const mapIncarnation = useRef(0)
  const remoteNotification = useRef(0)
  const renderedMapIncarnation = mapIncarnation.current
  const [text, setText] = useState('')
  const textRef = useRef('')
  const [path, setPath] = useState<JsonPath>([])
  const [editor, setEditor] = useState('')
  const [editorDirty, setEditorDirty] = useState(false)
  const [editorLoaded, setEditorLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [busyLabel, setBusyLabel] = useState('Opening saved mod JSON...')
  const opening = useRef(false)
  const dirtyRef = useRef(false)
  const [editError, setEditError] = useState<string>()
  const [error, setError] = useState<string>()
  const [downloadError, setDownloadError] = useState<{ message: string; recovery?: { filename: string; text: string } }>()
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'failed'>('saved')
  const [expanded, setExpanded] = useState<readonly ExpansionRule[]>(INITIAL_EXPANSION)
  const [treePages, setTreePages] = useState<ReadonlyMap<string, number>>(new Map())
  const [treeRowLimit, setTreeRowLimit] = useState(TREE_ROW_PAGE_SIZE)
  const [query, setQuery] = useState('')
  const [searchLimit, setSearchLimit] = useState(PAGE_SIZE)
  const [optionQuery, setOptionQuery] = useState('')
  const [optionLimit, setOptionLimit] = useState(PAGE_SIZE)
  const explorerState = useRef({ expanded, treePages, treeRowLimit, query, searchLimit, optionQuery, optionLimit })
  explorerState.current = { expanded, treePages, treeRowLimit, query, searchLimit, optionQuery, optionLimit }
  const relationshipRequest = useRef(0)
  const [relationships, setRelationships] = useState<readonly InspectorRelationship[]>([])
  const [relationshipBusy, setRelationshipBusy] = useState(false)
  const [relationshipsLoaded, setRelationshipsLoaded] = useState(false)
  const [relationshipLimit, setRelationshipLimit] = useState(PAGE_SIZE)
  const [issueLimit, setIssueLimit] = useState(PAGE_SIZE)
  const [review, setReview] = useState<string>()
  const [reviewLimit, setReviewLimit] = useState(PAGE_SIZE)
  const [reviewBusy, setReviewBusy] = useState(false)
  const [removeConfirmation, setRemoveConfirmation] = useState(false)
  const [removing, setRemoving] = useState(false)
  const reviewHeading = useRef<HTMLHeadingElement>(null)
  const viewElement = useRef<HTMLDivElement>(null)
  const [localTab, setLocalTab] = useState<InspectorTab>('document')
  const tab = view ?? localTab
  const setTab = (next: InspectorTab) => { if (onViewChange) onViewChange(next); else setLocalTab(next) }
  const [mapOpened, setMapOpened] = useState(false)
  // Direct menu links can open the map without clicking its tab; keep its history mounted afterward
  useEffect(() => { if (tab === 'map') setMapOpened(true) }, [tab])
  const [inputEpoch, setInputEpoch] = useState(0)
  const [mapDirty, setMapDirty] = useState(false)
  const mapDirtyRef = useRef(false)
  const mapActions = useRef<DraftActions | undefined>(undefined)
  // A clean remote row can reopen the same file without replacing this parent view
  // Bind every child callback to that opening so a retired map cannot edit its successor
  const isMapCurrent = useCallback(() => mounted.current && storage.isCurrent() && mapIncarnation.current === renderedMapIncarnation, [storage, renderedMapIncarnation])
  const onMapDraftChange = useCallback<DraftChangeHandler>((dirty, actions) => {
    if (!isMapCurrent()) return
    mapDirtyRef.current = dirty
    mapActions.current = actions && { owner: actions.owner, save: () => isMapCurrent() ? actions.save() : Promise.resolve(false), discard: () => { if (isMapCurrent()) return actions.discard() } }
    setMapDirty(dirty); if (dirty) onDraftChange?.(true, registeredActions)
  }, [onDraftChange, isMapCurrent])
  const localTabsId = useId()
  const tabsId = navigationId ?? localTabsId
  const fileInput = useRef<HTMLInputElement>(null)
  const saving = useRef(false)
  const savePromise = useRef<Promise<void> | undefined>(undefined)
  const draftActions = useRef<DraftActions | undefined>(undefined)
  const registeredActions = useMemo<DraftActions>(() => ({ owner: controller.owner, save: () => draftActions.current?.save() ?? Promise.resolve(false), discard: () => draftActions.current?.discard() }), [])
  const saveFailed = useRef(false)
  const mounted = useRef(true)
  const openingSourceStarted = useRef<Uint8Array | undefined>(undefined)
  const parsed = useMemo<ParsedDocument | undefined>(() => { try { return text ? parseDocument(text) : undefined } catch { return undefined } }, [text])
  const fileInfo = useMemo(() => parsed && active ? deriveInspectorFileInfo(parsed, text !== active.originalText) : undefined, [parsed, text, active?.originalText])
  const original = useMemo(() => active && review === text ? parseDocument(active.originalText) : undefined, [active?.id, active?.originalText, review, text])
  const resolver = useMemo(() => parsed ? createResolver(parsed) : undefined, [parsed])
  const selected = parsed ? nodeAtPath(parsed.root, path) : undefined
  const annotation = resolver?.annotate(path)
  const branchPath = selected?.kind === 'object' || selected?.kind === 'array' ? path : path.slice(0, -1)
  const visibleTree = useMemo(() => parsed ? prepareVisibleTree(parsed.root, expanded, treePages, path, treeRowLimit, PAGE_SIZE) : undefined, [parsed, expanded, treePages, path, treeRowLimit])
  const options = resolver?.options(path) ?? []
  const filteredOptions = options.filter(option => `${option.value} ${option.label} ${option.detail ?? ''}`.toLowerCase().includes(optionQuery.trim().toLowerCase()))
  useEffect(() => { relationshipRequest.current++; setRelationshipBusy(false); setRelationships([]); setRelationshipsLoaded(false); setRelationshipLimit(PAGE_SIZE); setIssueLimit(PAGE_SIZE) }, [resolver, path])
  async function findRelationships() {
    if (!resolver) return
    const request = ++relationshipRequest.current
    setRelationshipBusy(true)
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    if (request !== relationshipRequest.current) return
    try { setRelationships(resolver.relationships(path)); setRelationshipsLoaded(true) }
    catch (reason) { setError(message(reason)) }
    finally { if (request === relationshipRequest.current) setRelationshipBusy(false) }
  }
  const changes = useMemo(() => original && parsed ? diffDocuments(original, parsed) : [], [original, parsed])
  const originalResolver = useMemo(() => original ? createResolver(original) : undefined, [original])
  const groups = useMemo(() => {
    const grouped = new Map<string, DocumentChange[]>()
    for (const change of changes.slice(0, reviewLimit)) {
      const group = grouped.get(change.group) ?? []
      group.push(change); grouped.set(change.group, group)
    }
    return [...grouped.entries()]
  }, [changes, reviewLimit])
  const [matches, setMatches] = useState<readonly JsonNode[]>([])
  const [searching, setSearching] = useState(false)
  const [searchComplete, setSearchComplete] = useState(true)
  const [searchStopped, setSearchStopped] = useState(false)
  const [scannedNodes, setScannedNodes] = useState(0)
  const searchCancellation = useRef<(() => void) | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    const result: JsonNode[] = []
    const scheduler = createSearchScheduler()
    let scanned = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    setMatches([]); setScannedNodes(0); setSearchStopped(false)
    const cancel = () => { cancelled = true; scheduler.close(); if (timer !== undefined) clearTimeout(timer) }
    searchCancellation.current = () => { cancel(); setSearchStopped(true); setScannedNodes(scanned); setMatches([...result]); setSearching(false); setSearchComplete(false) }
    if (!parsed || !resolver || !query.trim()) { setSearching(false); setSearchComplete(true); return cancel }
    setSearching(true); setSearchComplete(false)
    const normalized = query.trim().toLowerCase()
    let lastPublished = performance.now()
    const frames: { node: JsonNode; index: number; count: number; root?: boolean }[] = [{ node: parsed.root, index: 0, count: 1, root: true }]
    const scan = () => {
      if (cancelled) return
      let processed = 0
      const started = performance.now()
      while (frames.length && processed++ < SEARCH_SLICE_NODE_LIMIT && result.length < searchLimit) {
        if (processed % SEARCH_TIME_CHECK_INTERVAL === 0 && performance.now() - started >= SEARCH_SLICE_MS) break
        const frame = frames.at(-1)!
        const index = frame.index++
        const node = index >= frame.count ? undefined : frame.root ? frame.node : childAt(frame.node, index)
        if (!node) { frames.pop(); continue }
        scanned++
        const container = node.kind === 'object' || node.kind === 'array'
        const entityRecord = node.path[0] === 'Entities' && node.path.length === 2
        const annotation = container && node.path[0] !== 'Tree' && !entityRecord ? undefined : resolver.annotate(node.path)
        if (`${node.key ?? node.path.at(-1) ?? ''} ${container ? '' : node.raw} ${annotation?.label ?? ''} ${formatJsonPath(node.path)}`.toLowerCase().includes(normalized)) result.push(node)
        if (container) frames.push({ node, index: 0, count: childCount(node) })
      }
      const now = performance.now()
      if (now - lastPublished >= SEARCH_PROGRESS_INTERVAL_MS) { lastPublished = now; setScannedNodes(scanned); setMatches([...result]) }
      if (frames.length && result.length < searchLimit) scheduler.schedule(scan)
      else { scheduler.close(); setScannedNodes(scanned); setMatches(result); setSearching(false); setSearchComplete(!frames.length) }
    }
    timer = setTimeout(() => scheduler.schedule(scan), SEARCH_DEBOUNCE_MS)
    return cancel
  }, [parsed, resolver, query, searchLimit])

  useEffect(() => {
    mounted.current = true
    void storage.list().then(value => { if (mounted.current && storage.isCurrent()) setDrafts(value) }).catch(reason => setError(message(reason)))
    return () => { mounted.current = false }
  }, [storage])
  useEffect(() => {
    if (!active || !controller.snapshot().dirty || saving.current || saveFailed.current || !controller.canTransfer()) return
    const timer = setTimeout(() => { void persist() }, EDITOR_QUIET_MS)
    return () => clearTimeout(timer)
  }, [editor, path, text, mapDirty, active, saveState, inputEpoch])
  useEffect(() => {
    const element = viewElement.current
    if (tab !== 'document' || !element) return
    let held = false, releaseTimer: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      clearTimeout(releaseTimer)
      if (!held) return
      held = false
      if (storage.isCurrent()) { controller.setInteraction(viewOwner, 'gesture', false); setInputEpoch(value => value + 1) }
    }
    const begin = (event: PointerEvent) => {
      if (event.button !== 0 || !storage.isCurrent()) return
      // Recovery and file commands require an idle controller and must not block on their own clicks
      if (!(event.target instanceof Element) || !event.target.closest('.inspector-tree-panel, .inspector-context')) return
      clearTimeout(releaseTimer)
      held = true
      controller.setInteraction(viewOwner, 'gesture', true)
    }
    // A quiet save must keep the pressed node mounted until its click handler records the selection
    // Pointerup precedes click; the task fallback also releases gestures whose click was suppressed
    const release = () => { if (held) releaseTimer = setTimeout(finish, 0) }
    element.addEventListener('pointerdown', begin, true)
    window.addEventListener('pointerup', release); window.addEventListener('click', finish)
    window.addEventListener('pointercancel', finish); window.addEventListener('blur', finish)
    return () => {
      element.removeEventListener('pointerdown', begin, true)
      window.removeEventListener('pointerup', release); window.removeEventListener('click', finish)
      window.removeEventListener('pointercancel', finish); window.removeEventListener('blur', finish)
      finish()
    }
  }, [storage, tab])
  useEffect(() => {
    if (storage.session.document) {
      open(inspectorDraft(storage.session.document), tab, true)
      void storage.ready().then(async () => {
        if (!mounted.current || !storage.isCurrent()) return
        // Receipt confirmation clears a pending ref; render again so file controls reflect that completion
        setInputEpoch(value => value + 1)
        const request = storage.session.applyRequested
        if (!request || !storage.isCurrent()) return
        storage.session.applyRequested = undefined
        const snapshot = controller.snapshot()
        if (snapshot.documentId !== request.documentId || snapshot.dirty || JSON.stringify(snapshot.input) !== request.input) { setEditError('The draft changed before Apply. Review it and apply again.'); return }
        await storage.apply(snapshot.documentId, snapshot.revision!)
      }).catch(reason => { if (mounted.current) { setError(message(reason)); setSaveState('failed') } })
    } else void storage.ready().catch(reason => { if (mounted.current) setError(message(reason)) })
    return () => {
      queueMicrotask(() => { if (!mounted.current && storage.session.transferView === viewOwner) { controller.release(viewOwner); storage.session.transferView = undefined } })
    }
  }, [storage])
  useEffect(() => {
    if (!openSource || openingSourceStarted.current === openSource.bytes) return
    openingSourceStarted.current = openSource.bytes
    void (async () => {
      try {
        await storage.ready()
        if (!storage.isCurrent() || controller.snapshot().dirty) throw new Error('Finish the open Editor draft before opening this mod source')
        await storage.import(openSource.filename, openSource.text, INSPECTOR_REFERENCE_ID, openSource.bytes)
      } catch (reason) { if (mounted.current) setError(message(reason)) }
      finally { onOpenSourceFinished?.() }
    })()
  }, [controller, onOpenSourceFinished, openSource, storage])
  useLayoutEffect(() => {
    const capture = () => {
      const documentId = activeRef.current?.id
      storage.session.explorer = documentId ? { documentId, ...explorerState.current } : undefined
      const main = document.querySelector<HTMLElement>('.main-shell')
      storage.session.scroll = { tab, x: window.scrollX, y: window.scrollY, mainLeft: main?.scrollLeft ?? 0, mainTop: main?.scrollTop ?? 0 }
      const element = document.activeElement
      const textField = element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
      // Marked navigation regions and canvases are keyboard targets too; an owned save must restore them
      const markedControl = (element instanceof HTMLElement || element instanceof SVGElement) && element.dataset.editorFocus
      if ((textField || element instanceof HTMLSelectElement || markedControl) && viewElement.current?.contains(element)) controller.rememberFocus(viewOwner, { key: element instanceof HTMLTextAreaElement ? 'json' : element.dataset.editorFocus ?? '', start: textField ? element.selectionStart : null, end: textField ? element.selectionEnd : null, direction: textField ? element.selectionDirection : null })
      else controller.rememberFocus(viewOwner, undefined)
    }
    storage.session.captureFocus = capture
    restoreFocus()
    if (active && tab !== 'map' && storage.session.scroll?.tab === tab) restoreScroll()
    return () => { if (storage.session.captureFocus === capture) storage.session.captureFocus = undefined }
  }, [active, storage, tab])
  function restoreFocus() {
    const focus = controller.snapshot().focus
    if (focus?.key) {
      const element = focus.key === 'json' ? viewElement.current?.querySelector<HTMLTextAreaElement>('textarea') : [...(viewElement.current?.querySelectorAll<HTMLElement | SVGElement>('[data-editor-focus]') ?? [])].find(element => element.dataset.editorFocus === focus.key)
      if (element && (!document.activeElement || document.activeElement === document.body)) { element.focus(); if ((element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) && focus.start !== null && focus.end !== null) element.setSelectionRange(focus.start, focus.end, focus.direction ?? undefined) }
    }
  }
  function restoreScroll() {
    const position = storage.session.scroll
    if (!position) return
    // Owned saves retire stale callbacks; restore position only after the reopened editor's content mounts
    // A loading map is shorter and would clamp scroll before its canvas becomes available
    const main = document.querySelector<HTMLElement>('.main-shell')
    if (main) { main.scrollLeft = position.mainLeft; main.scrollTop = position.mainTop }
    if (window.scrollX !== position.x || window.scrollY !== position.y) window.scrollTo(position.x, position.y)
    storage.session.scroll = undefined
  }
  useEffect(() => repository.subscribe(() => {
    const notification = ++remoteNotification.current, incarnation = mapIncarnation.current, id = activeRef.current?.id
    const current = () => mounted.current && storage.isCurrent() && remoteNotification.current === notification && mapIncarnation.current === incarnation && !controller.snapshot().dirty && !saving.current && !opening.current && activeRef.current?.id === id
    if (!current()) return
    void storage.list().then(rows => { if (current()) setDrafts(rows) }).catch(reason => { if (current()) setError(message(reason)) })
    if (id) void (async () => {
      // A notification may arrive during an untouched gesture or while a read is in flight
      // Wait for release, then recheck both owner and dirty input before adopting the row
      await controller.waitForTransfer()
      if (!current()) return
      const row = await storage.get(id)
      await controller.waitForTransfer()
      if (!current()) return
      if (row && row.revision !== activeRef.current?.revision) open(row, tab)
    })().catch(reason => { if (current()) setError(message(reason)) })
  }), [storage])
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (controller.snapshot().dirty || saving.current) { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])
  useEffect(() => {
    onDraftChange?.(controller.snapshot().dirty || saveState !== 'saved', registeredActions)
  }, [editor, editorDirty, path, text, inputEpoch, mapDirty, saveState, onDraftChange, registeredActions])
  useEffect(() => () => onDraftChange?.(false), [onDraftChange])
  useEffect(() => { if (initialDraftId) void openSavedDraft(initialDraftId) }, [initialDraftId])
  async function saveToLibrary() {
    const row = activeRef.current
    if (!row || !onSaveToLibrary || dirtyRef.current || mapDirtyRef.current || controller.snapshot().input?.text !== row.draftText || !beginOperation('Saving mod revision to CryKit...')) return
    setLibraryError(undefined); setLibraryResult(undefined)
    try {
      const result = await onSaveToLibrary(row.draftText, row.filename, undefined, false, false, controller.owner)
      if (mounted.current) setLibraryResult(result)
    } catch (reason) { if (mounted.current) setLibraryError(message(reason)) }
    finally { endOperation() }
  }
  function beginOperation(label: string, allowUnsaved = false) {
    if (opening.current || saving.current || (!allowUnsaved && (controller.snapshot().dirty || saveFailed.current))) return false
    opening.current = true; setBusyLabel(label); setBusy(true)
    return true
  }
  function endOperation() { opening.current = false; if (mounted.current) setBusy(false) }
  function captureField(value: string, dirty: boolean) {
    controller.editField(viewOwner, 'editor', value)
    controller.editField(viewOwner, 'editorLoaded', true)
    controller.editField(viewOwner, 'editorDirty', dirty)
    controller.editField(viewOwner, 'workingText', textRef.current)
    const node = parsed ? nodeAtPath(parsed.root, path) : undefined
    const unfinished = dirty && node ? textRef.current.slice(0, node.start) + value + textRef.current.slice(node.end) : textRef.current
    controller.editText(viewOwner, unfinished)
  }
  function edit(value: string) {
    if (opening.current || !storage.isCurrent()) return
    captureField(value, true)
    setLibraryResult(undefined); setLibraryError(undefined); setEditor(value); setEditorDirty(true); dirtyRef.current = true; onDraftChange?.(true, registeredActions); setEditError(undefined); setReview(undefined)
  }
  function select(nextPath: JsonPath) {
    if (opening.current) return
    if (dirtyRef.current) { setEditError('Apply or discard the pending JSON edit before selecting another field.'); return }
    const node = parsed ? nodeAtPath(parsed.root, nextPath) : undefined
    if (!node) return
    controller.editPath(viewOwner, nextPath); controller.editField(viewOwner, 'editor', node.raw); controller.editField(viewOwner, 'editorLoaded', true); controller.editField(viewOwner, 'editorDirty', false)
    setQuery(''); setPath(nextPath); setEditor(node.raw); setEditorLoaded(true); setEditError(undefined); setOptionQuery(''); setOptionLimit(PAGE_SIZE)
    setExpanded(previous => revealPath(previous, nextPath))
  }
  function open(row: InspectorDraft, nextTab: InspectorTab = 'document', hydrating = false) {
    if (!hydrating) storage.remember(row)
    if (!hydrating) controller.open(viewOwner, row.id, row.revision, { original: row.originalText, applied: row.draftText, reference: row.referenceId }, row.unfinished ?? { text: row.draftText, editedPath: [], fieldState: null, validation: 'valid' })
    const snapshot = controller.snapshot()
    const input = snapshot.input ?? row.unfinished
    const fields = (input?.fieldState && typeof input.fieldState === 'object' && !Array.isArray(input.fieldState) ? input.fieldState : {}) as Readonly<Record<string, import('../domain/types').JsonValue>>
    const working = typeof fields.workingText === 'string' ? fields.workingText : row.draftText
    const field = typeof fields.editor === 'string' ? fields.editor : ''
    const pending = fields.editorDirty === true
    // An owned command or manual file open restores its saved tab; a settled controlled remount honors the requested route
    const restoreSavedTab = !hydrating || storage.session.hydration !== undefined || view === undefined
    const savedLibrary = storage.session.libraryResult
    const explorer = hydrating && storage.session.explorer?.documentId === row.id ? storage.session.explorer : undefined
    setLibraryResult(hydrating && savedLibrary?.documentId === row.id && savedLibrary.revision === row.revision ? savedLibrary.result : undefined); setLibraryError(undefined)
    if (!hydrating) { storage.session.libraryResult = undefined; storage.session.explorer = undefined }
    mapIncarnation.current++
    mapDirtyRef.current = false; mapActions.current = undefined; setMapDirty(false)
    activeRef.current = row; textRef.current = working; saveFailed.current = false
    setActive(row); setText(working); setPath(input?.editedPath ?? []); setEditor(field); setEditorLoaded(fields.editorLoaded === true); setEditorDirty(pending); dirtyRef.current = pending; setReview(undefined); setError(undefined); setSaveState('saved'); setTab(restoreSavedTab && fields.tab === 'map' ? 'map' : nextTab); setRemoveConfirmation(false)
    // A quiet save retires its view owner without discarding later inert navigation
    // Search and relationship results are rebuilt from the newly admitted document
    setExpanded(explorer?.expanded ?? INITIAL_EXPANSION); setTreePages(explorer?.treePages ?? new Map()); setTreeRowLimit(explorer?.treeRowLimit ?? TREE_ROW_PAGE_SIZE)
    setQuery(explorer?.query ?? ''); setSearchLimit(explorer?.searchLimit ?? PAGE_SIZE); setOptionQuery(explorer?.optionQuery ?? ''); setOptionLimit(explorer?.optionLimit ?? PAGE_SIZE)
    // Persisted field input can be a scalar or array; whole-document input keeps its object-root check
    if (pending) { try { (input?.editedPath.length ? parseJsonFragment : parseDocument)(field); setEditError(undefined) } catch (reason) { setEditError(message(reason)) } }
    else setEditError(undefined)
  }
  async function openSavedDraft(id: string) {
    if (!beginOperation('Opening saved mod JSON...')) return
    setError(undefined)
    try {
      const row = await storage.get(id)
      if (!mounted.current || !storage.isCurrent()) return
      if (!row) {
        setDrafts(previous => previous.filter(item => item.id !== id))
        setError('This saved inspector draft was removed in another tab. Choose another draft or import a copy.')
        return
      }
      if (controller.snapshot().dirty || saving.current) {
        setError('Finish or discard the open draft edits before opening another saved draft.')
        return
      }
      setDrafts(previous => previous.map(item => item.id === row.id ? summarizeInspectorDraft(row) : item))
      open(row, tab === 'map' ? 'map' : 'document')
    } catch (reason) {
      if (mounted.current) setError(`Draft could not be opened: ${message(reason)}`)
    } finally {
      endOperation()
    }
  }
  async function reopenSavedVersion() {
    const previous = activeRef.current
    if (!previous || !beginOperation('Reopening saved mod JSON...', true)) return
    try { await storage.reopen(previous.id) }
    catch (reason) { if (mounted.current && storage.isCurrent()) setError(message(reason)) }
    finally { endOperation() }
  }
  function persist(): Promise<void> {
    if (savePromise.current) return savePromise.current
    const promise = persistQueued()
    savePromise.current = promise
    void promise.finally(() => { if (savePromise.current === promise) savePromise.current = undefined })
    return promise
  }
  async function persistQueued() {
    if (!controller.canTransfer() || saveFailed.current || !activeRef.current || !controller.snapshot().dirty && !storage.pending() || !storage.isCurrent()) return
    saving.current = true
    onDraftChange?.(true, registeredActions)
    setSaveState('saving')
    try {
      const row = activeRef.current
      if (storage.pending()) await storage.retry()
      else await storage.save(row.id, row.revision)
    } catch (reason) {
      saveFailed.current = true
      if (mounted.current && storage.isCurrent()) { setError(message(reason)); setSaveState('failed') }
    } finally { saving.current = false }
  }
  async function retryPendingOperation() {
    if (opening.current || saving.current || !storage.isCurrent() || !storage.session.recovery) return
    // Reconcile the provider's exact command even when import has no active row or removal has closed it
    opening.current = true; setBusy(true); setBusyLabel('Recovering editor operation...')
    try { await storage.retry() }
    catch (reason) { if (mounted.current && storage.isCurrent()) setError(message(reason)) }
    finally { endOperation() }
  }
  async function apply() {
    if (opening.current || saving.current || !activeRef.current || !storage.isCurrent()) return false
    try {
      parseDocument(controller.snapshot().input!.text)
      if (controller.snapshot().dirty) {
        storage.session.applyRequested = { documentId: activeRef.current.id, input: JSON.stringify(controller.snapshot().input) }
        await persist(); return false
      }
      opening.current = true; setBusy(true)
      await storage.apply(activeRef.current.id, activeRef.current.revision)
      return true
    } catch (reason) { if (mounted.current) setEditError(message(reason)); return false }
    finally { endOperation() }
  }
  function applyMapText(next: string, expected: string) {
    if (opening.current || removing || reviewBusy || dirtyRef.current || textRef.current !== expected) return false
    // Map edits share the inspector queue and revision check; they never mutate the archived original
    controller.editText(viewOwner, next); controller.editField(viewOwner, 'workingText', next); controller.editField(viewOwner, 'editorLoaded', false)
    textRef.current = next; setText(next); setEditorLoaded(false); setReview(undefined); setLibraryResult(undefined); setLibraryError(undefined)
    return true
  }
  async function createMapMod() {
    if (!beginOperation('Creating map mod...')) return
    try {
      const text = newMapProject(crypto.randomUUID(), new Date().toISOString())
      const row = await storage.import('map-placements.json', text, INSPECTOR_REFERENCE_ID, undefined, 'map')
      if (mounted.current && storage.isCurrent()) { setDrafts(previous => [summarizeInspectorDraft(row), ...previous]); open(row, 'map'); setMapOpened(true) }
    } catch (reason) { if (mounted.current) setError(storage.session.recovery ? message(reason) : `Map mod could not be created: ${message(reason)}`) }
    finally { endOperation() }
  }
  async function importFile(file: File) {
    if (!beginOperation('Importing and validating mod JSON...')) return
    const previousId = activeRef.current?.id
    const previousText = textRef.current
    try {
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      const importedText = await readModFile(file)
      const row = await storage.import(file.name, importedText, INSPECTOR_REFERENCE_ID, new Uint8Array(await file.arrayBuffer()), tab === 'map' ? 'map' : 'document')
      if (!mounted.current || !storage.isCurrent()) return
      if (activeRef.current?.id !== previousId || textRef.current !== previousText || dirtyRef.current || saving.current) { setDrafts(previous => [summarizeInspectorDraft(row), ...previous]); setError('Imported mod was saved. Finish the open edits before choosing it from saved drafts.'); return }
      setDrafts(previous => [summarizeInspectorDraft(row), ...previous]); open(row, tab === 'map' ? 'map' : 'document')
    } catch (reason) { if (mounted.current) setError(storage.session.recovery ? message(reason) : `Import failed: ${message(reason)}`) } finally { endOperation() }
  }
  draftActions.current = {
    save: async () => {
      if (opening.current) return false
      const previousFailure = saveFailed.current
      saveFailed.current = false
      if (!controller.canTransfer()) { saveFailed.current = previousFailure; return false }
      await persist()
      const saved = !saveFailed.current && storage.isCurrent() && !controller.snapshot().dirty
      if (saved) onDraftChange?.(false)
      return saved
    },
    discard: async () => {
      if (opening.current) return false
      const row = activeRef.current
      if (!row) return true
      await mapActions.current?.discard()
      controller.discard(viewOwner)
      textRef.current = row.draftText
      setText(row.draftText)
      setReview(undefined)
      saveFailed.current = false
      await persist()
      if (saveFailed.current || !storage.isCurrent()) return false
      if (activeRef.current) open(activeRef.current)
      onDraftChange?.(false)
      return true
    },
  }
  async function prepareReview() {
    setReviewBusy(true)
    await new Promise<void>(resolve => { if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(resolve, 0)); else setTimeout(resolve, 0) })
    setReviewLimit(PAGE_SIZE); setReview(text); setReviewBusy(false)
  }
  useEffect(() => {
    if (review !== undefined && review === text) { reviewHeading.current?.focus(); reviewHeading.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }) }
  }, [review, text])
  useEffect(() => { viewElement.current?.querySelector('.inspector-tree-row.is-selected')?.scrollIntoView?.({ block: 'nearest' }) }, [path, query])
  async function removeDraft() {
    const row = activeRef.current
    if (!row || !beginOperation('Removing editor file...')) return
    setRemoving(true)
    try {
      await storage.remove(row.id, row.revision)
      if (!mounted.current || !storage.isCurrent()) return
      setDrafts(previous => previous.filter(item => item.id !== row.id))
      if (activeRef.current?.id !== row.id || dirtyRef.current || saving.current) { setError('The editor entry was removed. Your open edits remain available to download.'); return }
      activeRef.current = undefined; textRef.current = ''; dirtyRef.current = false
      setActive(undefined); setText(''); setEditor(''); setEditorLoaded(false); setReview(undefined); setRemoveConfirmation(false); setError(undefined); onDraftChange?.(false)
    } catch (reason) { if (mounted.current) setError(storage.session.recovery ? message(reason) : `Draft removal failed: ${message(reason)}`) }
    finally { endOperation(); if (mounted.current) setRemoving(false) }
  }
  function download(filename: string, body: string | Uint8Array, type = 'application/json') {
    if (!storage.isCurrent()) return
    if (typeof body === 'string' && hasUnpairedSurrogate(body)) {
      setDownloadError({ message: 'This text contains an unpaired UTF-16 surrogate that cannot be downloaded as UTF-8 without changing it. Correct the text or download it for recovery.', recovery: { filename: `${filename}.utf16le`, text: body } })
      return
    }
    try {
      initiateDownload(filename, body, type, () => { if (!storage.isCurrent()) throw new Error('This editor view was retired') }, token)
      if (storage.isCurrent()) setDownloadError(undefined)
    } catch (reason) { if (storage.isCurrent()) setDownloadError({ message: message(reason) }) }
  }
  function downloadOriginal(row: InspectorDraft) {
    if (row.originalBytes) download(`original-${row.filename}`, row.originalBytes)
    else download(`original-${row.filename}.utf16le`, encodeEditorText(row.originalText), 'application/octet-stream')
  }
  const pendingRecovery = storage.session.phase === 'recovery' ? storage.session.recovery : undefined
  const blockedSwitch = busy || removing || reviewBusy || storage.pending() || controller.snapshot().dirty || saveState !== 'saved'
  const workspaceToolbar = <div className="inspector-toolbar"><Field label="Files opened in this tool"><select value={active?.id ?? ''} disabled={blockedSwitch} onChange={event => { if (event.target.value) void openSavedDraft(event.target.value) }}><option value="">Choose a recent file</option>{drafts.map(row => <option key={row.id} value={row.id}>{draftLabels.get(row.id)}</option>)}</select></Field><Button disabled={blockedSwitch} onClick={() => fileInput.current?.click()}>Open JSON file</Button><Button tone="secondary" disabled={blockedSwitch} onClick={() => void createMapMod()}>New map mod</Button><input ref={fileInput} type="file" accept=".json,application/json" className="inspector-file-input" aria-label="Open mod JSON file" disabled={blockedSwitch} onChange={event => { const file = event.target.files?.[0]; if (file) void importFile(file); event.target.value = '' }}/>{active && <span role="status" className="inspector-save-state">{pendingRecovery ? pendingRecovery.outcome.status === 'saved' ? 'Saved; reopening pending' : 'Save outcome uncertain' : saveState === 'saving' ? 'Saving draft...' : saveState === 'failed' || controller.snapshot().dirty ? 'Unsaved draft' : mapDirty ? 'Saved placement input' : editorDirty ? 'Saved JSON edit; not applied' : repository.kind === 'account' ? 'Saved on this device' : 'Saved in this browser'}</span>}</div>
  return <div className="mod-inspector" ref={viewElement} onCompositionStart={() => controller.setInteraction(viewOwner, 'composition', true)} onCompositionEnd={() => { controller.setInteraction(viewOwner, 'composition', false); setInputEpoch(value => value + 1) }}>
    {!embedded && <ScreenHeader eyebrow="Mod JSON tool" title="Mod Inspector" description="Explore a Crystal Edit mod's JSON, look up IDs, and edit a copy."/>}
    {!embedded && <ModWorkspaceNavigation id={tabsId} view={tab} includeLibrary={false} disabled={mapDirty ? ['document', 'dictionary'] : editorDirty ? ['map'] : []} onChange={next => { if (next !== 'library') setTab(next) }}/>}
    {busy && <p role="status">{busyLabel}</p>}
    {downloadError && <InlineNotice title="Download could not start" tone="danger"><p>{downloadError.message}</p>{downloadError.recovery && <Button tone="secondary" onClick={() => download(downloadError.recovery!.filename, encodeEditorText(downloadError.recovery!.text), 'application/octet-stream')}>Download reviewed text for recovery</Button>}</InlineNotice>}
    {pendingRecovery && <InlineNotice title={pendingRecovery.outcome.status === 'saved' ? 'Operation saved; reopening pending' : 'Operation outcome needs recovery'} tone="warning"><p>{pendingRecovery.outcome.status === 'saved' ? 'The operation was saved. Retry to reopen its verified result.' : 'The save outcome is uncertain. Retry checks the same operation before continuing.'}</p>{error && <p>{error}</p>}<Button tone="secondary" disabled={busy || removing} onClick={() => void retryPendingOperation()}>Retry operation</Button>{controller.snapshot().input && <Button tone="secondary" onClick={() => download(`${active?.filename ?? 'mod.json'}.unfinished.utf16le`, encodeEditorText(controller.snapshot().input!.text), 'application/octet-stream')}>Download open draft for recovery</Button>}</InlineNotice>}
    {!pendingRecovery && error && <InlineNotice title={saveState === 'failed' ? storage.session.recovery ? 'Draft needs recovery' : 'Draft is not saved' : 'Inspector storage error'} tone="danger"><p>{error}</p>{saveState === 'failed' && <><p>Keep or download your open edits before reopening a saved version. Retry reconciles a pending save before starting another one.</p><div className="inspector-actions"><Button tone="secondary" disabled={busy || removing} onClick={() => { if (opening.current) return; saveFailed.current = false; setError(undefined); void persist() }}>Retry save</Button><Button tone="secondary" onClick={() => download(`${active?.filename ?? 'mod.json'}.unfinished.utf16le`, encodeEditorText(controller.snapshot().input?.text ?? text), 'application/octet-stream')}>Download unsaved draft for recovery</Button><Button tone="secondary" disabled={busy || removing} onClick={() => void reopenSavedVersion()}>Reopen saved version</Button></div></>}</InlineNotice>}
    {active && !active.originalBytes && <p className="inspector-local-note">Original bytes were not retained. Download original text preserves the saved UTF-16LE text for recovery.</p>}
    <section className="inspector-tab-panel" role="tabpanel" id={`${tabsId}-document-panel`} aria-labelledby={`${tabsId}-document-tab`} tabIndex={0} hidden={tab !== 'document'}>
    {tab === 'document' && workspaceToolbar}
    <details className="inspector-local-note"><summary>Drafts belong to this workspace</summary><p>Unfinished edits save separately from applied content. Account workspaces encrypt and sync those drafts. Save to CryKit adds an applied mod to your library for planning; download it to use in game.</p></details>
    {!active && <div className="inspector-panel inspector-empty"><h2>Open a mod to explore its JSON</h2><p>Choose a recent file or open a JSON file to see its records and decoded IDs.</p></div>}
    {active && fileInfo && <section className="inspector-file-summary" aria-label="Current file"><div className="inspector-file-heading"><h2>{fileInfo.title ?? active.filename}</h2><span>{fileInfo.edited ? 'Edited copy' : 'Original file'}</span><Button tone="quiet" disabled={blockedSwitch} onClick={() => setRemoveConfirmation(true)}>Remove from recent files</Button></div><p className="inspector-file-facts"><span>{fileInfo.version ? `Version ${fileInfo.version}` : fileInfo.versionState === 'invalid' ? 'Version unavailable' : 'Version not specified'}</span><span>File: {active.filename}</span></p>{fileInfo.projectId && <details><summary>Project ID</summary><code>{fileInfo.projectId}</code></details>}</section>}
    {removeConfirmation && active && <InlineNotice title="Remove this editor file?" tone="warning"><p>Remove {active.filename} from the Editor. Saved versions and the original remain in workspace history.</p><div className="inspector-actions"><Button tone="danger" disabled={blockedSwitch} onClick={() => void removeDraft()}>{removing ? 'Removing...' : 'Remove from editor'}</Button><Button tone="secondary" disabled={removing} onClick={() => setRemoveConfirmation(false)}>Keep saved draft</Button></div></InlineNotice>}
    {parsed && resolver && active && <>
      <div className="inspector-document-actions"><div className="inspector-actions"><Button disabled={editorDirty || reviewBusy} icon="download" onClick={() => void prepareReview()}>{reviewBusy ? 'Preparing export review...' : 'Review export'}</Button>{onSaveToLibrary && <Button disabled={blockedSwitch || editorDirty || mapDirty || text !== active.draftText} icon="archive" onClick={() => void saveToLibrary()} tone="secondary">Save to CryKit</Button>}</div><div className="inspector-actions inspector-copy-actions"><Button tone="quiet" disabled={editorDirty} icon="edit" onClick={() => select([])}>Edit whole document JSON</Button><Button tone="quiet" icon="download" onClick={() => downloadOriginal(active)}>{active.originalBytes ? 'Download original' : 'Download original text'}</Button></div><p className="inspector-local-note">{editorDirty ? 'Apply or discard the pending edit before export review.' : 'Select a value, edit it, and apply the change. Review the working copy before downloading.'}</p></div>
      {libraryError && <InlineNotice title="Mod not saved to CryKit" tone="danger">{libraryError} Your editor draft remains available. Correct the problem or retry Save to CryKit.</InlineNotice>}
      {libraryResult && <InlineNotice title={libraryResult.unchanged ? "This mod revision is already saved" : "Mod revision saved to CryKit"}><p>{libraryResult.title}. Choose this version in a Game Setup to use it for planning.</p>{libraryResult.warnings.length > 0 && <details><summary>Import coverage</summary><ul>{libraryResult.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}</InlineNotice>}
      <details className="inspector-format" data-state={resolver.editorVersion.state} key={resolver.editorVersion.state}><summary>Editor format: {resolver.editorVersion.label}</summary><p>{resolver.editorVersion.detail}</p></details>
      <div className="inspector-workspace"><section className="inspector-panel inspector-tree-panel">{active.referenceId !== resolver.referenceId ? <Sources anchor={<h2>JSON explorer</h2>} label="Sources for inspector labels"><p className="inspector-source">{resolver.sourceLabel}</p><p>Names and links use CryKit's bundled reference data. Reference updates do not alter your JSON.</p><p>This copy was opened with different CryKit reference data. That does not mean the mod is outdated.</p></Sources> : <h2>JSON explorer</h2>}<div className="inspector-branch-actions"><Button tone="quiet" onClick={() => setExpanded(previous => setExpansion(previous, branchPath, true, true))}>Expand branch</Button><Button tone="quiet" onClick={() => setExpanded(previous => setExpansion(previous, branchPath, false, true))}>Collapse branch</Button><small>Branch: <code>{formatJsonPath(branchPath)}</code>. Alt-click an expander to expand or collapse its entire branch.</small></div><Field label="Search keys, values, and decoded names"><input data-editor-focus="explorer-query" type="search" value={query} onChange={event => { setQuery(event.target.value); setSearchLimit(PAGE_SIZE) }} placeholder="Find a field or name"/></Field>{query.trim() ? <div className="inspector-search-results"><p role="status">{searching ? `Searching document... ${scannedNodes.toLocaleString()} values inspected` : `${searchStopped ? 'Search stopped. ' : ''}${matches.length}${searchComplete ? '' : '+'} matches`}</p>{searching && <Button tone="quiet" onClick={() => searchCancellation.current?.()}>Stop search</Button>}{!searching && matches.length === 0 && searchComplete && <p>No document fields match this search.</p>}{matches.slice(0, searchLimit).map(node => <button className="inspector-search-result" type="button" key={pathKey(node.path)} onClick={() => select(node.path)}><code>{formatJsonPath(node.path)}</code><span>{resolver.annotate(node.path)?.label ?? (node.kind === 'object' || node.kind === 'array' ? node.kind : node.raw)}</span></button>)}{!searchComplete && !searching && <Button tone="quiet" onClick={() => setSearchLimit(value => value + PAGE_SIZE)}>Show more matches</Button>}</div> : <ul className="inspector-tree">{visibleTree?.rows.map(row => <JsonTreeRow key={`${row.kind}:${pathKey(row.node.path)}`} row={row} resolver={resolver} selected={pathKey(path)} onSelect={select} onExpand={(nextPath, recursive) => setExpanded(previous => setExpansion(previous, nextPath, !isExpanded(previous, nextPath), recursive))} onMore={nextPath => setTreePages(previous => { const next = new Map(previous); next.set(pathKey(nextPath), (next.get(pathKey(nextPath)) ?? PAGE_SIZE) + PAGE_SIZE); return next })}/>)}{visibleTree?.hasMore && <li><Button tone="secondary" onClick={() => setTreeRowLimit(value => value + TREE_ROW_PAGE_SIZE)}>Show more visible rows</Button></li>}</ul>}</section>
      <section className="inspector-panel inspector-editor"><fieldset disabled={busy || removing} aria-label="Inspector editing controls" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}><h2>Selected value</h2><code className="inspector-path">{formatJsonPath(path)}</code><div className="inspector-context"><span>{selected?.kind}</span>{annotation && <><strong>{annotation.label}</strong><span>{annotation.status}</span>{annotation.provenance && ['unknown', 'ambiguous'].includes(annotation.status) ? <Sources anchor={<p>{annotation.detail}</p>} label="Sources for selected value"><p>{annotation.provenance}</p></Sources> : <p>{annotation.detail}</p>}{annotation.restrictions?.map(restriction => <p key={restriction}>{restriction}</p>)}{annotation.targetPath && <Button tone="quiet" onClick={() => select(annotation.targetPath!)}>Go to referenced record</Button>}</>}</div>{!editorLoaded && <Button tone="secondary" onClick={() => select(path)}>Load selected JSON for editing</Button>}<Field label="Exact JSON value" hint="Strings require quotes. Numbers keep their original precision. Objects and arrays can include arbitrary fields and records."><textarea disabled={!editorLoaded} spellCheck={false} value={editor} onChange={event => edit(event.target.value)} rows={selected?.kind === 'object' || selected?.kind === 'array' ? 14 : 4}/></Field>{editError && <p role="alert" className="inspector-error">{editError}</p>}<div className="inspector-actions"><Button disabled={!editorDirty || saving.current} onClick={() => void apply()}>Apply JSON edit</Button><Button tone="secondary" disabled={!editorDirty} onClick={() => { captureField(selected?.raw ?? '', false); setEditor(selected?.raw ?? ''); setEditorDirty(false); dirtyRef.current = false; setEditError(undefined) }}>Discard pending edit</Button></div>
      {options.length > 0 && <section className="inspector-options"><h3>Known values</h3><Field label="Search known values"><input data-editor-focus="options-query" type="search" value={optionQuery} onChange={event => { setOptionQuery(event.target.value); setOptionLimit(PAGE_SIZE) }}/></Field><div>{filteredOptions.slice(0, optionLimit).map((option, index) => <button type="button" className="inspector-option" key={`${option.value}:${index}`} onClick={() => edit(option.value)}><code>{option.value}</code><span>{option.label}{option.source !== 'enum' && <small>{option.detail} ({option.source})</small>}</span></button>)}</div>{filteredOptions.length > optionLimit && <Button tone="quiet" onClick={() => setOptionLimit(value => value + PAGE_SIZE)}>Show more values</Button>}{!filteredOptions.length && <p>No known values match. You can enter an unknown value directly.</p>}</section>}
      {path.length >= 2 && <Button tone="secondary" disabled={relationshipBusy} onClick={() => void findRelationships()}>{relationshipBusy ? 'Finding relationships...' : 'Find relationships'}</Button>}{relationshipsLoaded && relationships.length === 0 && <p>No relationships found for this field or record.</p>}{relationships.length > 0 && <section className="inspector-relationships"><h3>Relationships and backreferences</h3>{relationships.slice(0, relationshipLimit).map((relation, index) => <div key={index}><span>{relation.direction}: {relation.label}{relation.unresolved ? ' (unresolved)' : ''}</span><Button tone="quiet" onClick={() => select(relation.direction === 'incoming' ? relation.path : relation.targetPath ?? relation.path)}>Open {formatJsonPath(relation.direction === 'incoming' ? relation.path : relation.targetPath ?? relation.path)}</Button></div>)}{relationships.length > relationshipLimit && <Button tone="quiet" onClick={() => setRelationshipLimit(value => value + PAGE_SIZE)}>Show more relationships ({relationships.length - relationshipLimit} remaining)</Button>}</section>}
      </fieldset></section></div>
      {resolver.issues.length > 0 && <details className="inspector-panel"><summary>Inspected-field reference issues ({resolver.issues.length})</summary><p>Checks cover source metadata and inspected fields. Other fields have not been checked.</p><div className="inspector-issues">{resolver.issues.slice(0, issueLimit).map((issue, index) => <div key={index}><Button tone="quiet" onClick={() => select(issue.path)}>{formatJsonPath(issue.path)}</Button><span>{issue.severity}: {issue.message}</span></div>)}{resolver.issues.length > issueLimit && <Button tone="quiet" onClick={() => setIssueLimit(value => value + PAGE_SIZE)}>Show more issues ({resolver.issues.length - issueLimit} remaining)</Button>}</div></details>}
      {review === text && <section className="inspector-panel inspector-review" aria-label="Export review"><h2 ref={reviewHeading} tabIndex={-1}>Review original to draft</h2>{original && objectProperty(original.root, 'EditorVersion')?.raw !== objectProperty(parsed.root, 'EditorVersion')?.raw && <InlineNotice title="EditorVersion changed" tone="warning"><p>EditorVersion changed from {metadataPreview(objectProperty(original.root, 'EditorVersion'))} to {metadataPreview(objectProperty(parsed.root, 'EditorVersion'))}. Changing the marker does not migrate the mod format. Review compatibility with your Crystal Edit version before export.</p></InlineNotice>}<p>{changes.length ? 'Compare this draft with the original before downloading.' : active.originalText !== text ? 'JSON values match the original; formatting may differ.' : 'No changes. The draft matches the original.'}</p>{groups.map(([group, groupChanges]) => <section key={group}><h3>{group}</h3>{groupChanges.map((change, index) => <ReviewChange key={index} change={change} resolver={resolver} originalResolver={originalResolver}/>)}</section>)}{changes.length > reviewLimit && <Button tone="secondary" onClick={() => setReviewLimit(value => value + PAGE_SIZE)}>Show more changes ({changes.length - reviewLimit} remaining)</Button>}<div className="inspector-actions"><Button disabled={editorDirty} icon="download" onClick={() => download(active.filename, review)}>Download mod</Button><Button tone="secondary" onClick={() => setReview(undefined)}>Close review</Button></div><p>The original remains unchanged after export.</p></section>}
    </>}
    </section>
    <section className="inspector-tab-panel" role="tabpanel" id={`${tabsId}-map-panel`} aria-labelledby={`${tabsId}-map-tab`} tabIndex={0} hidden={tab !== 'map'}>
      {tab === 'map' && workspaceToolbar}
      {!active && <div className="inspector-panel inspector-empty"><h2>Create or Open a Map Mod</h2><p>New map mod starts with an empty Crystal Edit project. Open JSON file edits a separate browser copy of an existing project.</p></div>}
      {active && <div className="inspector-actions"><strong>{fileInfo?.title ?? active.filename}</strong><Button disabled={blockedSwitch} onClick={() => { setTab('document'); void prepareReview() }}>Review map export</Button><Button tone="secondary" onClick={() => downloadOriginal(active)}>{active.originalBytes ? 'Download original' : 'Download original text'}</Button></div>}
      {active && tab === 'map' && <Button disabled={saving.current || busy || controller.snapshot().input?.text === active.draftText} onClick={() => void apply()}>Apply document changes</Button>}
      {active && parsed && (mapOpened || tab === 'map') && <Suspense fallback={<p role="status">Opening map editor...</p>}><MapPlacementEditor key={renderedMapIncarnation} onReady={() => {
        // The lazy map can mount after the owner's layout effect, so restore its focused field when it exists
        if (tab === 'map' && isMapCurrent()) { restoreFocus(); restoreScroll() }
      }} document={parsed} disabled={busy || removing || reviewBusy || editorDirty} initialInput={(controller.snapshot().input?.fieldState as Record<string, import('../domain/types').JsonValue> | null)?.map} onInput={(key, value) => { if (!isMapCurrent()) return; controller.editMapField(viewOwner, key, value); controller.editField(viewOwner, 'tab', 'map'); setInputEpoch(value => value + 1); setMapDirty(true); onDraftChange?.(true, registeredActions) }} onGesture={value => { if (!isMapCurrent()) return; controller.setInteraction(viewOwner, 'gesture', value); if (!value) setInputEpoch(epoch => epoch + 1) }} onChange={(next, expected) => isMapCurrent() && applyMapText(next, expected)} onDraftChange={onMapDraftChange} onInspect={index => { if (!isMapCurrent()) return; select(['Entities', index]); setTab('document') }}/></Suspense>}
    </section>
    <section className="inspector-tab-panel" role="tabpanel" id={`${tabsId}-dictionary-panel`} aria-labelledby={`${tabsId}-dictionary-tab`} tabIndex={0} hidden={tab !== 'dictionary'}><EnumDictionary/></section>
  </div>
}

export function ModInspectorView(props: Parameters<typeof EditorWorkspaceView>[0] = {}) {
  return <EditorWorkspaceView {...props}/>
}
