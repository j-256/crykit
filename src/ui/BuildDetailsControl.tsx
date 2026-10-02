import { useEffect, useRef, useState } from 'react'
import type { Build } from '../domain/types'
import { MAX_SHORT_TEXT_LENGTH } from '../domain/limits'
import { Button, Field, InlineNotice } from './components'
import { BuildTagsField, buildTagsFromDraft, sameBuildTags, type BuildTagsDraft } from './BuildTagsField'
import type { DraftActions, DraftChangeHandler } from './drafts'

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

export function BuildDetailsControl({ build, suggestions, onSave, onDirtyChange }: { build: Build; suggestions: readonly string[]; onSave: (buildId: string, patch: BuildDetailsPatch) => Promise<void>; onDirtyChange: DraftChangeHandler }) {
  const [editingTitle, setEditingTitle] = useState(false)
  const [tagsOpen, setTagsOpen] = useState(false)
  const [draft, setDraft] = useState(() => initialDraft(build))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const inputRef = useRef<HTMLInputElement>(null)
  const headingRef = useRef<HTMLDivElement>(null)
  const summaryRef = useRef<HTMLElement>(null)
  const focusTargetRef = useRef<'title' | 'tags'>('title')
  const wasActiveRef = useRef(false)
  const draftRef = useRef(draft)
  const actionsRef = useRef<DraftActions | undefined>(undefined)
  const registeredActionsRef = useRef<DraftActions>({ save: () => actionsRef.current?.save() ?? Promise.resolve(false), discard: () => actionsRef.current?.discard() })
  const active = editingTitle || tagsOpen || detailsChanged(draft)

  useEffect(() => {
    if (editingTitle) { inputRef.current?.focus(); inputRef.current?.select() }
  }, [editingTitle])
  useEffect(() => {
    if (!active && wasActiveRef.current) {
      if (focusTargetRef.current === 'tags') summaryRef.current?.focus()
      else headingRef.current?.querySelector('button')?.focus()
    }
    wasActiveRef.current = active
  }, [active])

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
  const save = async () => {
    if (busy) return false
    const current = draftRef.current
    const title = current.title === current.original.title ? build.title : current.title.trim()
    if (!title) { setError('Enter a Build title.'); setEditingTitle(true); inputRef.current?.focus(); return false }
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
      if (tagsChanged(current)) setTagsOpen(true)
      return false
    } finally { setBusy(false) }
  }
  actionsRef.current = { save, discard: () => finish() }

  return <form className="build-details-control" onSubmit={event => { event.preventDefault(); void save() }}>
    <div className="build-title-control__heading" ref={headingRef}><h2>{build.title}</h2>{!editingTitle && <Button disabled={busy} icon="edit" onClick={() => { if (!active) reset(build); focusTargetRef.current = 'title'; setEditingTitle(true) }} tone="quiet" type="button">Rename</Button>}</div>
    {editingTitle && <Field label="Build title"><input disabled={busy} maxLength={MAX_SHORT_TEXT_LENGTH} onChange={event => change({ ...draftRef.current, title: event.target.value })} ref={inputRef} required value={draft.title}/></Field>}
    <details className="build-tags-control" open={tagsOpen} onToggle={event => {
      const open = event.currentTarget.open
      if (open === tagsOpen) return
      if (open && !active) { reset(build); focusTargetRef.current = 'tags' }
      setTagsOpen(open)
    }}>
      <summary aria-label={build.tags.length > 0 ? `Tags (${build.tags.length})` : 'Tags'} ref={summaryRef}>Tags{build.tags.length > 0 && <span className="build-tags-control__count">{build.tags.length}</span>}</summary>
      {tagsOpen && <div className="build-tags-control__editor"><BuildTagsField disabled={busy} draft={draft.tags} onChange={tags => change({ ...draftRef.current, tags })} suggestions={suggestions}/></div>}
    </details>
    {active && <div className="cluster build-details-control__actions"><Button disabled={busy} onClick={() => finish()} tone="quiet" type="button">Cancel details</Button><Button disabled={busy} icon="check" type="submit">{busy ? 'Saving details...' : 'Save details'}</Button></div>}
    {error && <InlineNotice title="Build details not saved" tone="danger">{error}</InlineNotice>}
  </form>
}
