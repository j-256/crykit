import { useId, useRef, useState } from 'react'
import { normalizeBuildTags } from '../domain/build-tags'
import { MAX_SHORT_TEXT_LENGTH } from '../domain/limits'
import { Button, Field, IconButton, InlineNotice } from './components'

const TAG_SUGGESTION_LIMIT = 12

export interface BuildTagsDraft {
  readonly tags: readonly string[]
  readonly input: string
}

export function buildTagsFromDraft(draft: BuildTagsDraft): readonly string[] {
  const pending = draft.input.trim()
  return normalizeBuildTags(pending ? [...draft.tags, pending] : draft.tags)
}

export function sameBuildTags(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((tag, index) => tag === right[index])
}

export function BuildTagsField({ draft, suggestions, onChange, disabled = false }: { draft: BuildTagsDraft; suggestions: readonly string[]; onChange: (draft: BuildTagsDraft) => void; disabled?: boolean }) {
  const listId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string>()
  const selected = new Set(draft.tags.map(tag => tag.toLowerCase()))
  const matching = suggestions.filter(tag => !selected.has(tag.toLowerCase()) && tag.toLowerCase().includes(draft.input.trim().toLowerCase())).slice(0, TAG_SUGGESTION_LIMIT)
  const add = () => {
    try {
      onChange({ tags: buildTagsFromDraft(draft), input: '' })
      setError(undefined)
      inputRef.current?.focus()
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'The tag could not be added.') }
  }
  return <div className="build-tags-field">
    {draft.tags.length > 0 && <ul aria-label="Build tags" className="build-tags-field__list">{draft.tags.map((tag, index) => <li key={`${index}:${tag}`}><span>{tag}</span><IconButton disabled={disabled} icon="close" label={`Remove tag ${tag}`} onClick={() => { setError(undefined); onChange({ ...draft, tags: draft.tags.filter((_, tagIndex) => tagIndex !== index) }) }}/></li>)}</ul>}
    <div className="build-tags-field__entry"><Field hint="Optional labels for finding Builds in your library." label="Add tag"><input aria-label="Add tag" disabled={disabled} list={listId} maxLength={MAX_SHORT_TEXT_LENGTH} onChange={event => { setError(undefined); onChange({ ...draft, input: event.target.value }) }} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); add() } }} placeholder="e.g. healer, early game" ref={inputRef} value={draft.input}/></Field><Button disabled={disabled || !draft.input.trim()} onClick={add} tone="secondary" type="button">Add tag</Button></div>
    <datalist id={listId}>{matching.map(tag => <option key={tag} value={tag}/>)}</datalist>
    {error && <InlineNotice title="Tag not added" tone="danger">{error}</InlineNotice>}
  </div>
}
