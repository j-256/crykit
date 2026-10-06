import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { Build } from '../domain/types'
import { MAX_SHORT_TEXT_LENGTH } from '../domain/limits'
import { Button, Field, IconButton, InlineNotice } from './components'
import { BuildTagsField, buildTagsFromDraft, sameBuildTags, type BuildTagsDraft } from './BuildTagsField'
import type { DraftActions, DraftChangeHandler } from './drafts'
import { Dropdown } from './Dropdown'
import { ErrorMessage } from './ErrorMessage'
import { Icon } from './icons'
import { useWorkspaceHeader, WorkspaceTitle } from './WorkspaceHeader'

const TITLE_REQUIRED_ERROR = 'Enter a Build title.'

export interface BuildDetailsPatch {
  readonly title?: string
  readonly tags?: readonly string[]
}

interface DetailsDraft {
  readonly original: Pick<Build, 'title' | 'tags'>
  readonly title: string
  readonly tags: BuildTagsDraft
}

function initialDraft(build: Pick<Build, 'title' | 'tags'>): DetailsDraft {
  return { original: build, title: build.title, tags: { tags: build.tags, input: '' } }
}

function tagsChanged(draft: DetailsDraft) {
  return Boolean(draft.tags.input.trim()) || !sameBuildTags(draft.tags.tags, draft.original.tags)
}

function detailsChanged(draft: DetailsDraft) {
  return draft.title !== draft.original.title || tagsChanged(draft)
}

export function BuildDetailsControl({ build, suggestions, onSave, onDirtyChange, compact = false, children }: { build: Build; suggestions: readonly string[]; onSave: (buildId: string, patch: BuildDetailsPatch) => Promise<void>; onDirtyChange: DraftChangeHandler; compact?: boolean; children?: ReactNode }) {
  const [moreOpen, setMoreOpen] = useState(false)
  const moreId = useId()
  const formId = useId()
  const workspace = useWorkspaceHeader()
  const workspaceActive = workspace?.active ?? true
  const moreRef = useRef<HTMLButtonElement>(null)
  const renameRef = useRef<HTMLButtonElement>(null)
  const menuRenameRef = useRef<HTMLButtonElement>(null)
  const [editingTitle, setEditingTitle] = useState(false)
  const [tagsOpen, setTagsOpen] = useState(false)
  const [draft, setDraft] = useState(() => initialDraft(build))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const inputRef = useRef<HTMLInputElement>(null)
  const summaryRef = useRef<HTMLElement>(null)
  const focusTargetRef = useRef<'title' | 'tags'>('title')
  const wasActiveRef = useRef(false)
  const wasEditingTitleRef = useRef(false)
  const draftRef = useRef(draft)
  const actionsRef = useRef<DraftActions | undefined>(undefined)
  const registeredActionsRef = useRef<DraftActions>({ save: () => actionsRef.current?.save() ?? Promise.resolve(false), discard: () => actionsRef.current?.discard() })
  const active = editingTitle || tagsOpen || detailsChanged(draft)

  useEffect(() => {
    // Reference research keeps this editor mounted without letting its hidden draft take focus
    if (workspaceActive && editingTitle && !wasEditingTitleRef.current) {
      inputRef.current?.focus()
      inputRef.current?.select()
    } else if (workspaceActive && !editingTitle && wasEditingTitleRef.current) {
      renameRef.current?.focus()
    } else if (workspaceActive && !active && wasActiveRef.current) {
      if (focusTargetRef.current === 'tags') summaryRef.current?.focus()
      else renameRef.current?.focus()
    }
    wasActiveRef.current = active
    wasEditingTitleRef.current = editingTitle
  }, [active, editingTitle, workspaceActive])

  const reset = (value: Pick<Build, 'title' | 'tags'>) => {
    const next = initialDraft(value)
    draftRef.current = next
    setDraft(next)
    setError(undefined)
  }
  const finish = (value: Pick<Build, 'title' | 'tags'> = build) => {
    reset(value)
    setEditingTitle(false)
    setTagsOpen(false)
    onDirtyChange(false)
  }
  const change = (next: DetailsDraft) => {
    draftRef.current = next
    setDraft(next)
    setError(undefined)
    const dirty = detailsChanged(next)
    onDirtyChange(dirty, dirty ? registeredActionsRef.current : undefined)
  }
  const startTitle = () => {
    if (!active) reset(build)
    focusTargetRef.current = 'title'
    setMoreOpen(false)
    setEditingTitle(true)
  }
  const cancelTitle = () => {
    // Title cancellation must not discard a tag draft started independently in More
    change({ ...draftRef.current, title: draftRef.current.original.title })
    setEditingTitle(false)
    setMoreOpen(false)
  }
  const save = async () => {
    if (busy) return false
    const current = draftRef.current
    const title = current.title === current.original.title ? build.title : current.title.trim()
    if (!title) { setError(TITLE_REQUIRED_ERROR); setEditingTitle(true); if (compact) setMoreOpen(false); if (workspaceActive) inputRef.current?.focus(); return false }
    setBusy(true)
    setError(undefined)
    try {
      const tags = tagsChanged(current) ? buildTagsFromDraft(current.tags) : build.tags
      const patch: BuildDetailsPatch = { ...(title !== build.title ? { title } : {}), ...(!sameBuildTags(tags, build.tags) ? { tags } : {}) }
      if (patch.title !== undefined || patch.tags !== undefined) await onSave(build.id, patch)
      finish({ title, tags })
      return true
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The Build details could not be saved.')
      if (compact && !editingTitle) setMoreOpen(true)
      if (tagsChanged(current)) setTagsOpen(true)
      return false
    } finally { setBusy(false) }
  }
  actionsRef.current = { save, discard: () => finish() }

  const controls = <div className="build-details-control">
    <div className="build-title-control__heading">{!compact && <h2>{build.title}</h2>}{!editingTitle && <Button disabled={busy} icon="edit" onClick={startTitle} ref={compact ? menuRenameRef : renameRef} tone="quiet" type="button">Rename</Button>}</div>
    {!compact && editingTitle && <Field label="Build title"><input disabled={busy} maxLength={MAX_SHORT_TEXT_LENGTH} onChange={event => change({ ...draftRef.current, title: event.target.value })} ref={inputRef} required value={draft.title}/></Field>}
    <details className="build-tags-control" open={tagsOpen} onToggle={event => {
      const open = event.currentTarget.open
      if (open === tagsOpen) return
      if (open && !active) { reset(build); focusTargetRef.current = 'tags' }
      setTagsOpen(open)
    }}>
      <summary aria-label={build.tags.length > 0 ? `Tags (${build.tags.length})` : 'Tags'} ref={summaryRef}>Tags{build.tags.length > 0 && <span className="build-tags-control__count">{build.tags.length}</span>}</summary>
      {tagsOpen && <div className="build-tags-control__editor"><BuildTagsField disabled={busy} draft={draft.tags} onChange={tags => change({ ...draftRef.current, tags })} suggestions={suggestions}/></div>}
    </details>
    {active && (!compact || !editingTitle) && <div className="cluster build-details-control__actions"><Button disabled={busy} onClick={() => finish()} tone="quiet" type="button">Cancel details</Button><Button disabled={busy} form={formId} icon="check" type="submit">{busy ? 'Saving details...' : 'Save details'}</Button></div>}
    {error && (!compact || !editingTitle) && <InlineNotice title="Build details not saved" tone="danger">{error}</InlineNotice>}
  </div>
  const metadataForm = <form hidden={compact} id={formId} onSubmit={event => { event.preventDefault(); void save() }}>{!compact && controls}</form>
  if (!compact) return metadataForm
  return <>
    {/* The portaled title stays associated with this mounted form while More is closed */}
    {metadataForm}
    <WorkspaceTitle><div className="build-title-inline">
      <h1 aria-label={build.title} className="build-title-input">{editingTitle
        ? <input aria-label="Build title" className="build-title-input__field" disabled={busy} form={formId} maxLength={MAX_SHORT_TEXT_LENGTH} onChange={event => change({ ...draftRef.current, title: event.target.value })} onInvalid={() => setError(TITLE_REQUIRED_ERROR)} onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); cancelTitle() } }} ref={inputRef} required value={draft.title}/>
        : moreOpen ? <span>{build.title}</span> : <button aria-label="Rename" className="build-title-inline__rename" disabled={busy} onClick={startTitle} ref={renameRef} title="Rename Build" type="button"><span>{build.title}</span><Icon name="edit"/></button>}
      </h1>
      {editingTitle && <div className="build-title-inline__actions"><IconButton disabled={busy} icon="close" label="Cancel details" onClick={() => finish()}/><IconButton disabled={busy} form={formId} icon="check" label="Save details" type="submit"/></div>}
      {editingTitle && error && <div className="build-title-inline__error" role="alert">{error === TITLE_REQUIRED_ERROR ? <span>{error}</span> : <><span>Build details not saved.</span><details><summary>Details</summary><ErrorMessage message={error}/></details></>}</div>}
    </div></WorkspaceTitle>
    <Button aria-controls={moreOpen ? moreId : undefined} aria-expanded={moreOpen} aria-haspopup="dialog" icon="more" onClick={() => setMoreOpen(open => !open)} ref={moreRef} title="More Build actions" tone="secondary" type="button">More</Button>
    <Dropdown anchorRef={moreRef} id={moreId} initialFocusRef={menuRenameRef} onClose={() => setMoreOpen(false)} onDismiss={() => setMoreOpen(false)} open={moreOpen && workspaceActive} title="Build actions">
      <div className="workspace-more">{controls}{children && <div className="workspace-more__commands">{children}</div>}</div>
    </Dropdown>
  </>
}
