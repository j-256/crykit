import { Sources } from './Sources'
import { memo, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { childAt, childCount, parseDocument, nodeAtPath, formatJsonPath, objectProperty, replaceJsonValue } from '../mod-inspector/document'
import { diffDocuments } from '../mod-inspector/diff'
import { createResolver, getEnumCatalog, INSPECTOR_REFERENCE_ID } from '../mod-inspector/reference'
import { getInspectorStorage, summarizeInspectorDraft } from '../mod-inspector/storage'
import { deriveInspectorFileInfo } from '../mod-inspector/file-info'
import type { DocumentChange, InspectorDraft, InspectorDraftSummary, InspectorRelationship, InspectorResolver, JsonNode, JsonPath, ParsedDocument } from '../mod-inspector/types'
import { Button, Field, InlineNotice, ScreenHeader } from './components'
import type { DraftActions, DraftChangeHandler } from './drafts'
import type { CatalogId } from '../domain/types'
import { readModFile } from './mod-inspector/import-file'
import { createSearchScheduler } from './mod-inspector/search-scheduler'
import { isExpanded, prepareVisibleTree, revealPath, setExpansion, type ExpansionRule, type VisibleTreeRow } from './mod-inspector/tree'
import './mod-inspector/inspector.css'

export type SaveModToLibrary = (text: string, filename: string, expectedCatalogId?: CatalogId, includeInReference?: boolean) => Promise<{ readonly title: string; readonly unchanged: boolean; readonly warnings: readonly string[] }>

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
const INSPECTOR_TABS = [{ id: 'document', label: 'JSON document' }, { id: 'dictionary', label: 'Enum dictionary' }] as const
type InspectorTab = typeof INSPECTOR_TABS[number]['id']
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
function download(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
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
  return <section className="inspector-panel inspector-dictionary"><h2>Exact enum names</h2><p>Shared reference for all mods. Search by name or numeric value; no file needs to be open.</p><Field label="Search enum names and values"><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Name, value, or enum family"/></Field><div className="inspector-enum-groups">{catalog.map(group => {
    const entries = group.entries.filter(option => `${group.name} ${option.value} ${option.label}`.toLowerCase().includes(normalized))
    if (!entries.length) return null
    return <details key={group.name} open={normalized ? true : undefined}><summary>{group.name} <small>({entries.length})</small></summary><dl>{entries.map(option => <div key={option.value}><dt><code>{option.value}</code></dt><dd>{option.label}</dd></div>)}</dl></details>
  })}</div>{!hasMatches && <p role="status">No enum names or values match this search. Try a shorter name, numeric value, or enum family.</p>}</section>
})

export function ModInspectorView({ onDraftChange, onSaveToLibrary, initialDraftId, embedded = false }: { readonly onDraftChange?: DraftChangeHandler; readonly onSaveToLibrary?: SaveModToLibrary; readonly initialDraftId?: string; readonly embedded?: boolean } = {}) {
  const [libraryResult, setLibraryResult] = useState<Awaited<ReturnType<SaveModToLibrary>>>()
  const [libraryError, setLibraryError] = useState<string>()
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
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'failed'>('saved')
  const [expanded, setExpanded] = useState<readonly ExpansionRule[]>(INITIAL_EXPANSION)
  const [treePages, setTreePages] = useState<ReadonlyMap<string, number>>(new Map())
  const [treeRowLimit, setTreeRowLimit] = useState(TREE_ROW_PAGE_SIZE)
  const [query, setQuery] = useState('')
  const [searchLimit, setSearchLimit] = useState(PAGE_SIZE)
  const [optionQuery, setOptionQuery] = useState('')
  const [optionLimit, setOptionLimit] = useState(PAGE_SIZE)
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
  const [tab, setTab] = useState<InspectorTab>('document')
  const tabsId = useId()
  const tabList = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const saving = useRef(false)
  const savePromise = useRef<Promise<void> | undefined>(undefined)
  const draftActions = useRef<DraftActions | undefined>(undefined)
  const registeredActions = useMemo<DraftActions>(() => ({ save: () => draftActions.current?.save() ?? Promise.resolve(false), discard: () => draftActions.current?.discard() }), [])
  const saveFailed = useRef(false)
  const mounted = useRef(true)
  const parsed = useMemo<ParsedDocument | undefined>(() => text ? parseDocument(text) : undefined, [text])
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
    void getInspectorStorage().list().then(setDrafts).catch(reason => setError(message(reason)))
    return () => { mounted.current = false }
  }, [])
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current || (activeRef.current && textRef.current !== activeRef.current.draftText)) { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])
  useEffect(() => {
    onDraftChange?.(editorDirty || saveState !== 'saved', registeredActions)
  }, [editorDirty, saveState, onDraftChange, registeredActions])
  useEffect(() => () => onDraftChange?.(false), [onDraftChange])
  useEffect(() => { if (initialDraftId) void openSavedDraft(initialDraftId) }, [initialDraftId])
  async function saveToLibrary() {
    const row = activeRef.current
    if (!row || !onSaveToLibrary || !beginOperation('Saving mod revision to CryKit...')) return
    setLibraryError(undefined); setLibraryResult(undefined)
    try {
      const result = await onSaveToLibrary(textRef.current, row.filename)
      if (mounted.current) setLibraryResult(result)
    } catch (reason) { if (mounted.current) setLibraryError(message(reason)) }
    finally { endOperation() }
  }
  function beginOperation(label: string, allowUnsaved = false) {
    if (opening.current || saving.current || dirtyRef.current || (!allowUnsaved && (saveFailed.current || (activeRef.current && textRef.current !== activeRef.current.draftText)))) return false
    opening.current = true; setBusyLabel(label); setBusy(true)
    return true
  }
  function endOperation() { opening.current = false; if (mounted.current) setBusy(false) }
  function edit(value: string) { if (opening.current) return; setLibraryResult(undefined); setLibraryError(undefined); setEditor(value); setEditorDirty(true); dirtyRef.current = true; setEditError(undefined); setReview(undefined) }
  function select(nextPath: JsonPath) {
    if (opening.current) return
    if (dirtyRef.current) { setEditError('Apply or discard the pending JSON edit before selecting another field.'); return }
    const node = parsed ? nodeAtPath(parsed.root, nextPath) : undefined
    if (!node) return
    setQuery(''); setPath(nextPath); setEditor(node.raw); setEditorLoaded(true); setEditError(undefined); setOptionQuery(''); setOptionLimit(PAGE_SIZE)
    setExpanded(previous => revealPath(previous, nextPath))
  }
  function open(row: InspectorDraft) {
    setLibraryResult(undefined); setLibraryError(undefined)
    activeRef.current = row; textRef.current = row.draftText; saveFailed.current = false
    setActive(row); setText(row.draftText); setPath([]); setEditor(''); setEditorLoaded(false); setEditorDirty(false); dirtyRef.current = false; setReview(undefined); setError(undefined); setEditError(undefined); setSaveState('saved'); setExpanded(INITIAL_EXPANSION); setTreePages(new Map()); setTreeRowLimit(TREE_ROW_PAGE_SIZE); setQuery(''); setTab('document'); setRemoveConfirmation(false)
  }
  async function openSavedDraft(id: string) {
    if (!beginOperation('Opening saved mod JSON...')) return
    setError(undefined)
    try {
      const row = await getInspectorStorage().get(id)
      if (!mounted.current) return
      if (!row) {
        setDrafts(previous => previous.filter(item => item.id !== id))
        setError('This saved inspector draft was removed in another tab. Choose another draft or import a copy.')
        return
      }
      if (dirtyRef.current || saving.current || (activeRef.current && textRef.current !== activeRef.current.draftText)) {
        setError('Finish or discard the open draft edits before opening another saved draft.')
        return
      }
      setDrafts(previous => previous.map(item => item.id === row.id ? summarizeInspectorDraft(row) : item))
      open(row)
    } catch (reason) {
      if (mounted.current) setError(`Draft could not be opened: ${message(reason)}`)
    } finally {
      endOperation()
    }
  }
  async function reopenSavedVersion() {
    const previous = activeRef.current
    if (!previous || !beginOperation('Reopening saved mod JSON...', true)) return
    const previousText = textRef.current
    try {
      const row = await getInspectorStorage().get(previous.id)
      if (!mounted.current) return
      if (activeRef.current?.id !== previous.id || textRef.current !== previousText || dirtyRef.current || saving.current) { setError('Finish the open edits before reopening the saved version.'); return }
      if (!row) { setError('This draft was removed in another tab. Download your draft before importing it again.'); return }
      setDrafts(items => items.map(item => item.id === row.id ? summarizeInspectorDraft(row) : item))
      open(row)
    } catch (reason) { if (mounted.current) setError(message(reason)) }
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
    if (saveFailed.current || !activeRef.current) return
    saving.current = true
    setSaveState('saving')
    try {
      while (activeRef.current && textRef.current !== activeRef.current.draftText) {
        const row = activeRef.current
        const saved = await getInspectorStorage().save(row.id, textRef.current, row.revision)
        activeRef.current = saved
        if (mounted.current) { setActive(saved); setDrafts(previous => previous.map(item => item.id === saved.id ? summarizeInspectorDraft(saved) : item)) }
      }
      if (mounted.current) setSaveState('saved')
    } catch (reason) {
      saveFailed.current = true
      if (mounted.current) { setError(message(reason)); setSaveState('failed') }
    } finally { saving.current = false }
  }
  function apply() {
    if (opening.current) return false
    try {
      const next = replaceJsonValue(textRef.current, path, editor)
      textRef.current = next; setText(next); setEditorDirty(false); dirtyRef.current = false; setEditError(undefined); setReview(undefined)
      void persist()
      return true
    } catch (reason) { setEditError(message(reason)); return false }
  }
  async function importFile(file: File) {
    if (!beginOperation('Importing and validating mod JSON...')) return
    const previousId = activeRef.current?.id
    const previousText = textRef.current
    try {
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      const importedText = await readModFile(file)
      const row = await getInspectorStorage().import(file.name, importedText, INSPECTOR_REFERENCE_ID)
      if (!mounted.current) return
      if (activeRef.current?.id !== previousId || textRef.current !== previousText || dirtyRef.current || saving.current) { setDrafts(previous => [summarizeInspectorDraft(row), ...previous]); setError('Imported mod was saved. Finish the open edits before choosing it from saved drafts.'); return }
      setDrafts(previous => [summarizeInspectorDraft(row), ...previous]); open(row)
    } catch (reason) { if (mounted.current) setError(`Import failed: ${message(reason)}`) } finally { endOperation() }
  }
  draftActions.current = {
    save: async () => {
      if (opening.current) return false
      const previousFailure = saveFailed.current
      saveFailed.current = false
      if (dirtyRef.current && !apply()) { saveFailed.current = previousFailure; return false }
      await persist()
      const saved = !saveFailed.current && textRef.current === activeRef.current?.draftText
      if (saved) onDraftChange?.(false)
      return saved
    },
    discard: async () => {
      if (opening.current) return false
      const row = activeRef.current
      if (!row) return true
      textRef.current = row.draftText
      setText(row.draftText)
      setReview(undefined)
      saveFailed.current = false
      await persist()
      if (saveFailed.current || textRef.current !== activeRef.current?.draftText) return false
      open(activeRef.current)
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
    if (!row || !beginOperation('Removing saved original and draft...')) return
    setRemoving(true)
    try {
      await getInspectorStorage().remove(row.id, row.revision)
      if (!mounted.current) return
      setDrafts(previous => previous.filter(item => item.id !== row.id))
      if (activeRef.current?.id !== row.id || dirtyRef.current || saving.current) { setError('The browser copy was removed. Your open edits remain available to download.'); return }
      activeRef.current = undefined; textRef.current = ''; dirtyRef.current = false
      setActive(undefined); setText(''); setEditor(''); setEditorLoaded(false); setReview(undefined); setRemoveConfirmation(false); setError(undefined); onDraftChange?.(false)
    } catch (reason) { if (mounted.current) setError(`Draft removal failed: ${message(reason)}`) }
    finally { endOperation(); if (mounted.current) setRemoving(false) }
  }
  function navigateTabs(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const index = INSPECTOR_TABS.findIndex(item => item.id === tab)
    let nextIndex: number
    switch (event.key) {
      case 'ArrowLeft': nextIndex = (index + INSPECTOR_TABS.length - 1) % INSPECTOR_TABS.length; break
      case 'ArrowRight': nextIndex = (index + 1) % INSPECTOR_TABS.length; break
      case 'Home': nextIndex = 0; break
      case 'End': nextIndex = INSPECTOR_TABS.length - 1; break
      default: return
    }
    event.preventDefault()
    setTab(INSPECTOR_TABS[nextIndex].id)
    tabList.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus()
  }
  const blockedSwitch = busy || removing || reviewBusy || editorDirty || saveState !== 'saved'
  return <div className="mod-inspector" ref={viewElement}>
    {!embedded && <ScreenHeader eyebrow="Mod JSON tool" title="Mod Inspector" description="Read any Crystal Edit mod JSON, resolve IDs, and follow record relationships. Edit and export a copy when needed."/>}
    <div className="inspector-tabs" role="tablist" aria-label="Inspector views" ref={tabList} onKeyDown={navigateTabs}>{INSPECTOR_TABS.map(item => <button key={item.id} type="button" role="tab" id={`${tabsId}-${item.id}-tab`} aria-controls={`${tabsId}-${item.id}-panel`} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} onClick={() => setTab(item.id)}>{item.label}</button>)}</div>
    {busy && <p role="status">{busyLabel}</p>}
    {error && <InlineNotice title={saveState === 'failed' ? 'Draft is not saved' : 'Inspector storage error'} tone="danger"><p>{error}</p>{saveState === 'failed' && <><p>Your unsaved draft remains visible. Reopen saved version discards this unsaved draft. Download a recovery copy first if you want to keep it. For a revision conflict, reopen the saved version before applying your changes again.</p><div className="inspector-actions"><Button tone="secondary" disabled={busy || removing} onClick={() => { if (opening.current) return; saveFailed.current = false; setError(undefined); void persist() }}>Retry save</Button><Button tone="secondary" onClick={() => download(active?.filename ?? 'mod.json', text)}>Download unsaved draft for recovery</Button><Button tone="secondary" disabled={busy || removing || editorDirty} onClick={() => void reopenSavedVersion()}>Reopen saved version</Button></div></>}</InlineNotice>}
    <section className="inspector-tab-panel" role="tabpanel" id={`${tabsId}-document-panel`} aria-labelledby={`${tabsId}-document-tab`} tabIndex={0} hidden={tab !== 'document'}>
    <div className="inspector-toolbar"><Field label="Files opened in this tool"><select value={active?.id ?? ''} disabled={blockedSwitch} onChange={event => { if (event.target.value) void openSavedDraft(event.target.value) }}><option value="">Choose a recent file</option>{drafts.map(row => <option key={row.id} value={row.id}>{draftLabels.get(row.id)}</option>)}</select></Field><Button disabled={blockedSwitch} onClick={() => fileInput.current?.click()}>Open JSON file</Button><input ref={fileInput} type="file" accept=".json,application/json" className="inspector-file-input" aria-label="Open mod JSON file" disabled={blockedSwitch} onChange={event => { const file = event.target.files?.[0]; if (file) void importFile(file); event.target.value = '' }}/>{active && <span role="status" className="inspector-save-state">{editorDirty ? 'Pending JSON edit' : saveState === 'saving' ? 'Saving draft...' : saveState === 'failed' ? 'Unsaved draft' : 'Saved in this browser'}</span>}</div>
    <p className="inspector-local-note">Draft edits stay in this workspace. Save to CryKit adds a version to the Mod library for use in Game Setups. Download the original and working copy to keep backups of your drafts.</p>
    {!active && <div className="inspector-panel inspector-empty"><h2>Open a mod to explore its JSON</h2><p>Choose a recent file or open a JSON file to see its records and decoded IDs.</p></div>}
    {active && fileInfo && <section className="inspector-file-summary" aria-label="Current file"><div className="inspector-file-heading"><h2>{fileInfo.title ?? active.filename}</h2><span>{fileInfo.edited ? 'Edited copy' : 'Original file'}</span><Button tone="quiet" disabled={blockedSwitch} onClick={() => setRemoveConfirmation(true)}>Remove from recent files</Button></div><p className="inspector-file-facts"><span>{fileInfo.version ? `Version ${fileInfo.version}` : fileInfo.versionState === 'invalid' ? 'Version unavailable' : 'Version not specified'}</span><span>File: {active.filename}</span></p>{fileInfo.projectId && <details><summary>Project ID</summary><code>{fileInfo.projectId}</code></details>}</section>}
    {removeConfirmation && active && <InlineNotice title="Remove this browser copy?" tone="warning"><p>Remove the saved original and draft for {active.filename} from this browser. Download copies first if you want to keep them.</p><div className="inspector-actions"><Button tone="danger" disabled={blockedSwitch} onClick={() => void removeDraft()}>{removing ? 'Removing...' : 'Remove original and draft'}</Button><Button tone="secondary" disabled={removing} onClick={() => setRemoveConfirmation(false)}>Keep saved draft</Button></div></InlineNotice>}
    {parsed && resolver && active && <>
      <div className="inspector-actions inspector-document-actions">{onSaveToLibrary && <Button disabled={blockedSwitch} onClick={() => void saveToLibrary()}>Save to CryKit</Button>}<Button tone="secondary" disabled={editorDirty} onClick={() => select([])}>Edit whole document JSON</Button><Button tone="secondary" onClick={() => download(`original-${active.filename}`, active.originalText)}>Download original</Button><Button disabled={editorDirty || reviewBusy} onClick={() => void prepareReview()}>{reviewBusy ? 'Preparing export review...' : 'Review export'}</Button>{editorDirty && <small>Apply or discard the pending edit before export review.</small>}</div>
      {libraryError && <InlineNotice title="Mod not saved to CryKit" tone="danger">{libraryError} Your editor draft remains available. Correct the problem or retry Save to CryKit.</InlineNotice>}
      {libraryResult && <InlineNotice title={libraryResult.unchanged ? "This mod revision is already saved" : "Mod revision saved to CryKit"}><p>{libraryResult.title}. Choose this version in a Game Setup to use it for planning.</p>{libraryResult.warnings.length > 0 && <details><summary>Import coverage</summary><ul>{libraryResult.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}</InlineNotice>}
      <details className="inspector-format" key={resolver.editorVersion.state} open={resolver.editorVersion.state !== 'matched' ? true : undefined}><summary>Editor format: {resolver.editorVersion.label}</summary><p>{resolver.editorVersion.detail}</p></details>
      <div className="inspector-workspace"><section className="inspector-panel inspector-tree-panel">{active.referenceId !== resolver.referenceId ? <Sources anchor={<h2>JSON explorer</h2>} label="Sources for inspector labels"><p className="inspector-source">{resolver.sourceLabel}</p><p>Names and links use CryKit's bundled reference data. Reference updates do not alter your JSON.</p><p>This browser copy was first opened with a different version of CryKit's reference data. This does not indicate that the mod is outdated.</p></Sources> : <h2>JSON explorer</h2>}<div className="inspector-branch-actions"><Button tone="quiet" onClick={() => setExpanded(previous => setExpansion(previous, branchPath, true, true))}>Expand branch</Button><Button tone="quiet" onClick={() => setExpanded(previous => setExpansion(previous, branchPath, false, true))}>Collapse branch</Button><small>Branch: <code>{formatJsonPath(branchPath)}</code>. Alt-click an expander to expand or collapse its entire branch.</small></div><Field label="Search keys, values, and decoded names"><input type="search" value={query} onChange={event => { setQuery(event.target.value); setSearchLimit(PAGE_SIZE) }} placeholder="Find a field or name"/></Field>{query.trim() ? <div className="inspector-search-results"><p role="status">{searching ? `Searching document... ${scannedNodes.toLocaleString()} values inspected` : `${searchStopped ? 'Search stopped. ' : ''}${matches.length}${searchComplete ? '' : '+'} matches`}</p>{searching && <Button tone="quiet" onClick={() => searchCancellation.current?.()}>Stop search</Button>}{!searching && matches.length === 0 && searchComplete && <p>No document fields match this search.</p>}{matches.slice(0, searchLimit).map(node => <button className="inspector-search-result" type="button" key={pathKey(node.path)} onClick={() => select(node.path)}><code>{formatJsonPath(node.path)}</code><span>{resolver.annotate(node.path)?.label ?? (node.kind === 'object' || node.kind === 'array' ? node.kind : node.raw)}</span></button>)}{!searchComplete && !searching && <Button tone="quiet" onClick={() => setSearchLimit(value => value + PAGE_SIZE)}>Show more matches</Button>}</div> : <ul className="inspector-tree">{visibleTree?.rows.map(row => <JsonTreeRow key={`${row.kind}:${pathKey(row.node.path)}`} row={row} resolver={resolver} selected={pathKey(path)} onSelect={select} onExpand={(nextPath, recursive) => setExpanded(previous => setExpansion(previous, nextPath, !isExpanded(previous, nextPath), recursive))} onMore={nextPath => setTreePages(previous => { const next = new Map(previous); next.set(pathKey(nextPath), (next.get(pathKey(nextPath)) ?? PAGE_SIZE) + PAGE_SIZE); return next })}/>)}{visibleTree?.hasMore && <li><Button tone="secondary" onClick={() => setTreeRowLimit(value => value + TREE_ROW_PAGE_SIZE)}>Show more visible rows</Button></li>}</ul>}</section>
      <section className="inspector-panel inspector-editor"><fieldset disabled={busy || removing} aria-label="Inspector editing controls" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}><h2>Selected value</h2><code className="inspector-path">{formatJsonPath(path)}</code><div className="inspector-context"><span>{selected?.kind}</span>{annotation && <><strong>{annotation.label}</strong><span>{annotation.status}</span>{annotation.provenance && ['unknown', 'ambiguous'].includes(annotation.status) ? <Sources anchor={<p>{annotation.detail}</p>} label="Sources for selected value"><p>{annotation.provenance}</p></Sources> : <p>{annotation.detail}</p>}{annotation.restrictions?.map(restriction => <p key={restriction}>{restriction}</p>)}{annotation.targetPath && <Button tone="quiet" onClick={() => select(annotation.targetPath!)}>Go to referenced record</Button>}</>}</div>{!editorLoaded && <Button tone="secondary" onClick={() => select(path)}>Load selected JSON for editing</Button>}<Field label="Exact JSON value" hint="Strings require quotes. Numbers keep their original precision. Objects and arrays can include arbitrary fields and records."><textarea disabled={!editorLoaded} spellCheck={false} value={editor} onChange={event => edit(event.target.value)} rows={selected?.kind === 'object' || selected?.kind === 'array' ? 14 : 4}/></Field>{editError && <p role="alert" className="inspector-error">{editError}</p>}<div className="inspector-actions"><Button disabled={!editorDirty} onClick={apply}>Apply JSON edit</Button><Button tone="secondary" disabled={!editorDirty} onClick={() => { setEditor(selected?.raw ?? ''); setEditorDirty(false); dirtyRef.current = false; setEditError(undefined) }}>Discard pending edit</Button></div>
      {options.length > 0 && <section className="inspector-options"><h3>Known values</h3><Field label="Search known values"><input type="search" value={optionQuery} onChange={event => { setOptionQuery(event.target.value); setOptionLimit(PAGE_SIZE) }}/></Field><div>{filteredOptions.slice(0, optionLimit).map((option, index) => <button type="button" className="inspector-option" key={`${option.value}:${index}`} onClick={() => edit(option.value)}><code>{option.value}</code><span>{option.label}{option.source !== 'enum' && <small>{option.detail} ({option.source})</small>}</span></button>)}</div>{filteredOptions.length > optionLimit && <Button tone="quiet" onClick={() => setOptionLimit(value => value + PAGE_SIZE)}>Show more values</Button>}{!filteredOptions.length && <p>No known values match. You can enter an unknown value directly.</p>}</section>}
      {path.length >= 2 && <Button tone="secondary" disabled={relationshipBusy} onClick={() => void findRelationships()}>{relationshipBusy ? 'Finding relationships...' : 'Find relationships'}</Button>}{relationshipsLoaded && relationships.length === 0 && <p>No relationships found for this field or record.</p>}{relationships.length > 0 && <section className="inspector-relationships"><h3>Relationships and backreferences</h3>{relationships.slice(0, relationshipLimit).map((relation, index) => <div key={index}><span>{relation.direction}: {relation.label}{relation.unresolved ? ' (unresolved)' : ''}</span><Button tone="quiet" onClick={() => select(relation.direction === 'incoming' ? relation.path : relation.targetPath ?? relation.path)}>Open {formatJsonPath(relation.direction === 'incoming' ? relation.path : relation.targetPath ?? relation.path)}</Button></div>)}{relationships.length > relationshipLimit && <Button tone="quiet" onClick={() => setRelationshipLimit(value => value + PAGE_SIZE)}>Show more relationships ({relationships.length - relationshipLimit} remaining)</Button>}</section>}
      </fieldset></section></div>
      {resolver.issues.length > 0 && <details className="inspector-panel"><summary>Inspected-field reference issues ({resolver.issues.length})</summary><p>Issues cover source metadata and inspected fields, rather than exhaustive validation of every field.</p><div className="inspector-issues">{resolver.issues.slice(0, issueLimit).map((issue, index) => <div key={index}><Button tone="quiet" onClick={() => select(issue.path)}>{formatJsonPath(issue.path)}</Button><span>{issue.severity}: {issue.message}</span></div>)}{resolver.issues.length > issueLimit && <Button tone="quiet" onClick={() => setIssueLimit(value => value + PAGE_SIZE)}>Show more issues ({resolver.issues.length - issueLimit} remaining)</Button>}</div></details>}
      {review === text && <section className="inspector-panel inspector-review" aria-label="Export review"><h2 ref={reviewHeading} tabIndex={-1}>Review original to draft</h2>{original && objectProperty(original.root, 'EditorVersion')?.raw !== objectProperty(parsed.root, 'EditorVersion')?.raw && <InlineNotice title="EditorVersion changed" tone="warning"><p>EditorVersion changed from {metadataPreview(objectProperty(original.root, 'EditorVersion'))} to {metadataPreview(objectProperty(parsed.root, 'EditorVersion'))}. Changing the marker does not migrate the mod format. Review compatibility with your Crystal Edit version before export.</p></InlineNotice>}<p>{changes.length ? 'Every semantic change below compares the immutable original with this draft. Review additions, removals, moves, and changed values before downloading.' : active.originalText !== text ? 'No semantic changes. Text formatting or equivalent value representations differ from the imported original.' : 'No semantic changes. The draft matches the imported original.'}</p>{groups.map(([group, groupChanges]) => <section key={group}><h3>{group}</h3>{groupChanges.map((change, index) => <ReviewChange key={index} change={change} resolver={resolver} originalResolver={originalResolver}/>)}</section>)}{changes.length > reviewLimit && <Button tone="secondary" onClick={() => setReviewLimit(value => value + PAGE_SIZE)}>Show more changes ({changes.length - reviewLimit} remaining)</Button>}<div className="inspector-actions"><Button disabled={editorDirty} onClick={() => download(active.filename, review)}>Download mod</Button><Button tone="secondary" onClick={() => setReview(undefined)}>Close review</Button></div><p>The original remains unchanged after export.</p></section>}
    </>}
    </section>
    <section className="inspector-tab-panel" role="tabpanel" id={`${tabsId}-dictionary-panel`} aria-labelledby={`${tabsId}-dictionary-tab`} tabIndex={0} hidden={tab !== 'dictionary'}><EnumDictionary/></section>
  </div>
}
