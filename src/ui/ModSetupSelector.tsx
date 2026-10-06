import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { BUNDLED_MOD_LIBRARY, STARTER_MOD_PROJECT_IDS } from '../catalog/mod-library-metadata'
import type { CatalogId, GameSetupRevision } from '../domain/types'
import { Button, InlineNotice } from './components'
import { formatAppError } from './model'
import { Sheet } from './Sheet'
import './mod-setup.css'

const PROJECTS = [...new Map([...BUNDLED_MOD_LIBRARY].reverse().map(mod => [mod.id, mod])).values()].sort((a, b) => a.title.localeCompare(b.title))

export function ModSetupSelector({ setup, onApply, onSkip, onClose }: { readonly setup?: GameSetupRevision; readonly onApply: (ids: readonly CatalogId[]) => Promise<void>; readonly onSkip: () => Promise<void>; readonly onClose: () => void }) {
  const [selected, setSelected] = useState<readonly CatalogId[]>(() => setup?.modComposition?.layers.filter(layer => layer.enabled && PROJECTS.some(mod => mod.id === layer.catalogId)).map(layer => layer.catalogId) ?? [])
  const [query, setQuery] = useState('')
  const [choosingMods, setChoosingMods] = useState(() => selected.length > 0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const pending = useRef(false)
  const search = useRef<HTMLInputElement>(null)
  const baseGame = useRef<HTMLButtonElement>(null)
  const initialFocusRef = useRef(choosingMods ? search : baseGame).current
  const choicesId = useId()
  useEffect(() => {
    // Expanding choices moves focus without restarting the dialog's initial autofocus cycle
    if (choosingMods) search.current?.focus()
  }, [choosingMods])
  const visible = useMemo(() => {
    const tokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
    return PROJECTS.filter(mod => tokens.every(token => `${mod.title} ${mod.declaredVersion ?? ''} ${mod.catalogNames?.join(' ') ?? ''}`.toLocaleLowerCase().includes(token)))
  }, [query])
  const toggle = (id: CatalogId) => setSelected(values => values.includes(id) ? values.filter(value => value !== id) : [...values, id])
  const move = (index: number, direction: -1 | 1) => setSelected(values => {
    const next = [...values]
    const peer = index + direction
    if (peer < 0 || peer >= next.length) return values
    ;[next[index], next[peer]] = [next[peer]!, next[index]!]
    return next
  })
  const save = async (skip = false, choices = selected) => {
    if (pending.current) return
    pending.current = true; setBusy(true); setError(undefined)
    try { await (skip ? onSkip() : onApply(choices)); onClose() }
    catch (reason) { setError(formatAppError(reason, 'Your mod choices could not be saved.')) }
    finally { pending.current = false; setBusy(false) }
  }
  return <Sheet open title="Choose your mods" width="wide" initialFocusRef={initialFocusRef} onClose={onClose} onRequestClose={() => !pending.current} description="Start with the base game or choose the mods you play with." footer={<div className="mod-setup-footer"><span role="status">{selected.length} selected</span><div className="form-actions"><Button disabled={busy} tone="quiet" onClick={() => void save(true)}>Skip for now</Button>{choosingMods && <Button disabled={busy || !selected.length} onClick={() => void save()}>{busy ? 'Saving choices...' : 'Use selected mods'}</Button>}</div></div>}>
    <div className="stack mod-setup">
      <section className="mod-setup-start"><div><h3>Playing the base game?</h3><p>You can add mods later. Saved Builds and character sheets keep their own rules.</p></div><Button disabled={busy} icon="arrow-right" onClick={() => void save(false, [])} ref={baseGame}>Continue without mods</Button></section>
      <Button aria-controls={choicesId} aria-expanded={choosingMods} disabled={busy} icon="layers" onClick={() => setChoosingMods(value => !value)} tone="secondary">Choose mods</Button>
      <div className="stack" hidden={!choosingMods} id={choicesId}>
      <p className="mod-setup-description">Your selected versions will appear in Reference and be enabled in the starting Game Setup.</p>
      <label className="mod-setup-search">Search mods<input ref={search} type="search" value={query} disabled={busy} onChange={event => setQuery(event.target.value)} placeholder="Mod name or version"/></label>
      <div className="cluster"><Button disabled={busy} tone="secondary" onClick={() => setSelected([...STARTER_MOD_PROJECT_IDS])}>Use starter selection</Button><Button disabled={busy || !selected.length} tone="quiet" onClick={() => setSelected([])}>Clear selection</Button><small>{visible.length} {visible.length === 1 ? 'mod' : 'mods'} shown</small></div>
      <div className="mod-setup-list" role="group" aria-label="Available mods">{visible.map(mod => <label className="mod-setup-row" key={mod.id}><input disabled={busy} type="checkbox" checked={selected.includes(mod.id)} onChange={() => toggle(mod.id)} aria-label={mod.title}/><span>{mod.title}</span><small>{mod.declaredVersion ? `v${mod.declaredVersion}` : 'Version unspecified'}</small></label>)}{!visible.length && <p role="status">No mods match. Your selections are kept while searching.</p>}</div>
      {selected.length > 1 && <details className="mod-setup-priority"><summary>Mod priority</summary><p>Later entries take priority when mods change the same record. Match this order to the mods used by your game.</p><ol>{selected.map((id, index) => <li key={id}><span>{PROJECTS.find(mod => mod.id === id)?.title}</span><div className="cluster"><Button disabled={busy || index === 0} tone="quiet" aria-label={`Move ${PROJECTS.find(mod => mod.id === id)?.title} earlier`} onClick={() => move(index, -1)}>Earlier</Button><Button disabled={busy || index === selected.length - 1} tone="quiet" aria-label={`Move ${PROJECTS.find(mod => mod.id === id)?.title} later`} onClick={() => move(index, 1)}>Later</Button></div></li>)}</ol></details>}
      </div>
      {error && <InlineNotice title="Mod choices not saved" tone="danger">{error} Your selections remain here. Try again or skip for now.</InlineNotice>}
    </div>
  </Sheet>
}
