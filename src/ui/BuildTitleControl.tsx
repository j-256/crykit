import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { Build } from '../domain/types'
import { MAX_SHORT_TEXT_LENGTH } from '../domain/limits'
import { Button, Field, InlineNotice } from './components'
import type { DraftActions, DraftChangeHandler } from './drafts'

export function BuildTitleControl({ build, onRename, onDirtyChange }: { build: Build; onRename: (buildId: string, title: string) => Promise<void>; onDirtyChange: DraftChangeHandler }) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(build.title)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const inputRef = useRef<HTMLInputElement>(null)
  const headingRef = useRef<HTMLDivElement>(null)
  const wasEditingRef = useRef(false)
  const titleRef = useRef(title)
  const actionsRef = useRef<DraftActions | undefined>(undefined)
  const registeredActionsRef = useRef<DraftActions>({ save: () => actionsRef.current?.save() ?? Promise.resolve(false), discard: () => actionsRef.current?.discard() })

  useEffect(() => {
    if (editing) { inputRef.current?.focus(); inputRef.current?.select() }
    else if (wasEditingRef.current) headingRef.current?.querySelector('button')?.focus()
    wasEditingRef.current = editing
  }, [editing])

  const finish = () => {
    setEditing(false)
    setError(undefined)
    onDirtyChange(false)
  }
  const save = async () => {
    if (busy) return false
    const nextTitle = titleRef.current.trim()
    if (!nextTitle) { setError('Enter a build title.'); inputRef.current?.focus(); return false }
    setBusy(true)
    setError(undefined)
    try {
      if (nextTitle !== build.title) await onRename(build.id, nextTitle)
      finish()
      return true
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The build title could not be saved.')
      return false
    } finally { setBusy(false) }
  }
  actionsRef.current = { save, discard: finish }
  const submit = (event: FormEvent) => { event.preventDefault(); void save() }
  const begin = () => { titleRef.current = build.title; setTitle(build.title); setEditing(true) }

  return <div className="build-title-control">
    <div className="build-title-control__heading" ref={headingRef}><h2>{build.title}</h2>{!editing && <Button icon="edit" onClick={begin} tone="quiet" type="button">Rename</Button>}</div>
    {editing && <form className="build-title-control__form" onSubmit={submit}>
      <Field label="Build title"><input disabled={busy} maxLength={MAX_SHORT_TEXT_LENGTH} onChange={event => { const value = event.target.value; titleRef.current = value; setTitle(value); setError(undefined); onDirtyChange(value !== build.title, value !== build.title ? registeredActionsRef.current : undefined) }} ref={inputRef} required value={title}/></Field>
      <div className="cluster"><Button disabled={busy} onClick={finish} tone="quiet" type="button">Cancel rename</Button><Button disabled={busy} icon="check" type="submit">{busy ? 'Saving title...' : 'Save title'}</Button></div>
      {error && <InlineNotice title="Title not saved" tone="danger">{error}</InlineNotice>}
    </form>}
  </div>
}
