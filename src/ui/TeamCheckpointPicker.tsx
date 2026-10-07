import { useMemo, useRef, useState } from 'react'
import type { BuildRevisionId, CatalogSnapshot, LocalData } from '../domain/types'
import { SUGGESTED_BUILD_SLOTS } from '../domain/build-planning'
import { subCommandLabel } from './definition-fields'
import { Button, Field } from './components'
import { entityName, resolveEntity } from './model'
import { Sheet } from './Sheet'
import './team-checkpoint-picker.css'

const CHECKPOINT_PAGE_SIZE = 30

export function teamCheckpointOptions(localData: LocalData, catalogs: readonly CatalogSnapshot[], selectedId: BuildRevisionId | null) {
  return Object.values(localData.buildRevisions).flatMap(revision => {
    const build = localData.builds[revision.buildId]
    if (!build || build.archived && revision.id !== selectedId) return []
    const setup = localData.gameSetups[revision.gameSetupRevisionId]
    const secondary = revision.content.secondaryClass ? resolveEntity(localData, catalogs, revision.content.secondaryClass) : undefined
    const className = revision.content.primaryClass ? entityName(localData, catalogs, revision.content.primaryClass) : 'No class selected'
    const command = secondary ? subCommandLabel({ name: secondary.name, record: secondary }) : revision.content.secondaryClass ? entityName(localData, catalogs, revision.content.secondaryClass) : 'No sub-command'
    const equipment = (setup?.slots.length ? setup.slots : SUGGESTED_BUILD_SLOTS).flatMap(slot => {
      const selection = revision.content.equipment[slot.id]
      return selection ? [`${slot.label}: ${entityName(localData, catalogs, selection.ref)}`] : []
    })
    const label = `${build.title} · r${revision.revision}`
    return [{ revision, label, title: build.title, className, command, equipment, setup: setup?.label ?? 'Game Setup unavailable', sample: build.tags.includes('sample'), archived: Boolean(build.archived), search: [label, revision.note, className, command, ...equipment, setup?.label].join(' ').toLocaleLowerCase() }]
  }).sort((left, right) => left.sample === right.sample ? left.title.localeCompare(right.title) || right.revision.revision - left.revision.revision : left.sample ? 1 : -1)
}

export function TeamCheckpointPicker({ slotNumber, value, localData, catalogs, disabled, onChange }: { readonly slotNumber: number; readonly value: BuildRevisionId | null; readonly localData: LocalData; readonly catalogs: readonly CatalogSnapshot[]; readonly disabled: boolean; readonly onChange: (value: BuildRevisionId | null) => void }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [showSamples, setShowSamples] = useState(true)
  const [limit, setLimit] = useState(CHECKPOINT_PAGE_SIZE)
  const searchRef = useRef<HTMLInputElement>(null)
  const options = useMemo(() => teamCheckpointOptions(localData, catalogs, value), [catalogs, localData, value])
  const normalized = query.trim().toLocaleLowerCase()
  const matching = options.filter(option => (showSamples || !option.sample) && (!normalized || option.search.includes(normalized)))
  const choose = (id: BuildRevisionId | null) => { onChange(id); setOpen(false) }
  return <div className="team-checkpoint-picker">
    <Button aria-label={`Choose checkpoint for Team slot ${slotNumber}`} aria-haspopup="dialog" data-revision-id={value ?? ''} disabled={disabled} icon="search" onClick={() => setOpen(true)} tone="secondary" type="button">{value ? 'Change checkpoint' : 'Choose a build checkpoint'}</Button>
    <Sheet open={open} title={`Choose checkpoint for Team slot ${slotNumber}`} description="Choose a saved checkpoint by its classes and equipment." initialFocusRef={searchRef} onClose={() => setOpen(false)} footer={value && <Button onClick={() => choose(null)} tone="quiet" type="button">Clear this Team slot</Button>}>
      <div className="team-checkpoint-picker__search">
        <Field label="Search build checkpoints" hint="Search names, classes, commands, equipment, Game Setups, or checkpoint notes."><input autoComplete="off" onChange={event => { setQuery(event.target.value); setLimit(CHECKPOINT_PAGE_SIZE) }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); if (matching.length === 1) choose(matching[0]!.revision.id) } }} ref={searchRef} type="search" value={query}/></Field>
        <label className="check-row"><input checked={showSamples} onChange={event => { setShowSamples(event.target.checked); setLimit(CHECKPOINT_PAGE_SIZE) }} type="checkbox"/><span>Show sample builds</span></label>
      </div>
      <p aria-live="polite">{matching.length} {matching.length === 1 ? 'checkpoint' : 'checkpoints'} found</p>
      <ul aria-label="Build checkpoints" className="team-checkpoint-picker__results">{matching.slice(0, limit).map(option => <li key={option.revision.id}><button aria-pressed={option.revision.id === value} className="team-checkpoint-picker__option" data-revision-id={option.revision.id} onClick={() => choose(option.revision.id)} type="button"><strong>{option.label}</strong><span>{option.className} · {option.command}</span><small>{option.setup}{option.sample ? ' · Sample build' : ''}{option.archived ? ' · Archived build' : ''}</small><small>{option.equipment.join(' · ') || 'No equipment selected'}</small>{option.revision.note && <small>{option.revision.note}</small>}{option.revision.id === value && <small>Selected checkpoint</small>}</button></li>)}</ul>
      {!matching.length && <p>No checkpoints match. Try another search{!showSamples && ' or show sample builds'}.</p>}
      {matching.length > limit && <Button onClick={() => setLimit(value => value + CHECKPOINT_PAGE_SIZE)} tone="secondary" type="button">Show more checkpoints</Button>}
    </Sheet>
  </div>
}
