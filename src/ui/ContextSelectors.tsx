import { useId, useRef, useState, type KeyboardEvent } from 'react'
import { requirePlaythrough } from '../domain'
import type { LocalData, PlaythroughId, ScenarioId, ScenarioKind } from '../domain/types'
import { Button, InlineNotice } from './components'
import { Dropdown } from './Dropdown'
import { Icon, type IconName } from './icons'
import { formatAppError } from './model'
import { useNavigation } from './navigation'

const SCENARIO_LABELS: Record<ScenarioKind, string> = { recordedCurrent: 'Recorded current', draft: 'Draft party', hypothetical: 'Hypothetical' }
const NO_SCENARIO = ''

interface ContextOption {
  readonly id: string
  readonly label: string
  readonly detail: string
}

interface ContextAction {
  readonly label: string
  readonly run: () => void
  readonly disabled?: boolean
}

function ContextSelector({ label, icon, value, selectedId, options, hint, empty, busy, actions, onSelect }: { label: string; icon: IconName; value: string; selectedId?: string; options: readonly ContextOption[]; hint: string; empty: string; busy: boolean; actions: readonly ContextAction[]; onSelect: (id: string) => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string>()
  const anchorRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  const id = useId()
  const tokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const visible = options.filter((option) => tokens.every((token) => `${option.label} ${option.detail}`.toLocaleLowerCase().includes(token)))
  const choose = async (optionId: string) => {
    if (busy) return
    if (optionId === selectedId) { setOpen(false); return }
    setError(undefined)
    try { await onSelect(optionId); setOpen(false) } catch (reason) { setError(formatAppError(reason, `${label} could not be switched.`)) }
  }
  const openPicker = () => { setQuery(''); setError(undefined); setOpen(true) }
  const browse = (event: KeyboardEvent<HTMLElement>) => {
    const buttons = [...(resultsRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
    if (!buttons.length) return
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const inSearch = document.activeElement === searchRef.current
    let next: number
    if (event.key === 'ArrowDown') next = (current + 1) % buttons.length
    else if (event.key === 'ArrowUp') next = current <= 0 ? buttons.length - 1 : current - 1
    else if (event.key === 'Home' && !inSearch) next = 0
    else if (event.key === 'End' && !inSearch) next = buttons.length - 1
    else if (event.key === 'Enter' && inSearch) { event.preventDefault(); buttons[0]?.click(); return }
    else return
    event.preventDefault()
    buttons[next]?.focus({ preventScroll: true })
    buttons[next]?.scrollIntoView({ block: 'nearest' })
  }

  return <div className="context-picker">
    <button aria-controls={open ? id : undefined} aria-expanded={open} aria-haspopup="dialog" aria-label={`${label}: ${value}`} className="context-item" disabled={busy} onClick={() => open ? setOpen(false) : openPicker()} onKeyDown={(event) => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (!open) openPicker() } }} ref={anchorRef} title={`${label}: ${value}`} type="button"><Icon name={icon}/><span className="context-item__text"><span className="context-item__label">{label}</span><span className="context-item__value">{value}</span></span><Icon name="chevron-down"/></button>
    <Dropdown anchorRef={anchorRef} id={id} initialFocusRef={searchRef} onClose={() => setOpen(false)} onDismiss={() => setOpen(false)} open={open} title={`Choose ${label.toLocaleLowerCase()}`}>
      <div className="search-field definition-dropdown__search"><Icon name="search"/><input aria-label={`Search ${label.toLocaleLowerCase()} choices`} onChange={(event) => setQuery(event.target.value)} onKeyDown={browse} placeholder={`Search ${label.toLocaleLowerCase()}s`} ref={searchRef} type="search" value={query}/></div>
      <p className="context-picker__hint">{hint}</p>
      {error && <div className="context-picker__error"><InlineNotice title={`${label} switch failed`} tone="danger">{error}</InlineNotice></div>}
      <div aria-busy={busy} className="picker-results" onKeyDown={browse} ref={resultsRef}>
        {visible.map((option) => <button aria-pressed={option.id === selectedId} className="picker-result" disabled={busy} key={option.id} onClick={() => void choose(option.id)} type="button"><span className="picker-result__content"><span className="picker-result__heading"><strong>{option.label}</strong>{option.id === selectedId && <Icon name="check"/>}</span><small className="picker-result__source">{option.detail}</small></span></button>)}
        {!visible.length && <p className="context-picker__hint">{options.length ? 'No matching choices.' : empty}</p>}
      </div>
      <div className="definition-dropdown__actions">{actions.map((action) => <Button disabled={busy || action.disabled} key={action.label} onClick={() => { setOpen(false); action.run() }} tone="quiet">{action.label}</Button>)}</div>
    </Dropdown>
  </div>
}

export function ContextSelectors({ localData, busy, onSelectPlaythrough, onSelectScenario }: { localData: LocalData; busy: boolean; onSelectPlaythrough: (id: PlaythroughId) => Promise<void>; onSelectScenario: (id: ScenarioId | null) => Promise<void> }) {
  const navigation = useNavigation()
  const [switching, setSwitching] = useState(false)
  const switchingRef = useRef(false)
  const playthrough = requirePlaythrough(localData)
  const gameSetup = playthrough.currentGameSetupRevisionId ? localData.gameSetups[playthrough.currentGameSetupRevisionId] : undefined
  const scenario = playthrough.activeScenarioId ? playthrough.scenarios[playthrough.activeScenarioId] : undefined
  const change = async (action: () => Promise<void>) => {
    if (switchingRef.current) return
    switchingRef.current = true
    setSwitching(true)
    try { await action() } finally { switchingRef.current = false; setSwitching(false) }
  }
  const page = navigation.route.page
  const showScenario = page.page === 'inventory' || page.page === 'characters' || page.page === 'progress' || (page.page === 'builds' && (page.view === 'teams' || page.view === 'scenario' || page.view === 'scenario-new'))
  const disabled = busy || switching
  const selectScenario = async (id: string) => {
    await onSelectScenario(id === NO_SCENARIO ? null : id as ScenarioId)
    const page = navigation.route.page
    if (page.page === 'builds' && (page.view === 'teams' || page.view === 'scenario')) {
      navigation.navigate({ page: id ? { page: 'builds', view: 'scenario', scenarioId: id as ScenarioId } : { page: 'builds', view: 'teams' }, overlays: [], query: {} })
    }
  }
  return <div className={`context-bar__group${showScenario ? ' context-bar__group--scenario' : ''}`}>
    <ContextSelector actions={[{ label: 'Manage Playthrough', run: () => navigation.navigate({ page: { page: 'settings', section: 'playthrough' }, overlays: [], query: {} }) }]} busy={disabled} empty="No Playthroughs." hint="Select the game save you are tracking. Builds keep their own Game Setup; this choice supplies tracking and readiness data." icon="archive" label="Playthrough" onSelect={(id) => change(() => onSelectPlaythrough(id as PlaythroughId))} options={Object.values(localData.playthroughs).sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id)).map((entry) => ({ id: entry.id, label: entry.label, detail: entry.id === playthrough.id ? 'Active Playthrough' : 'Saved in this browser' }))} selectedId={playthrough.id} value={playthrough.label}/>
    {showScenario && <ContextSelector actions={[{ label: 'Manage party plans', run: () => navigation.navigate({ page: { page: 'builds', view: 'teams' }, overlays: [], query: {} }) }, { label: 'New party plan', disabled: !gameSetup, run: () => navigation.navigate({ page: { page: 'builds', view: 'scenario-new' }, overlays: [], query: {} }) }]} busy={disabled} empty="No party plans yet." hint="Choose a tracked party for inventory and readiness checks." icon="team" label="Party plan" onSelect={(id) => change(() => selectScenario(id))} options={[{ id: NO_SCENARIO, label: 'None selected', detail: 'Leave all saved party plans available' }, ...Object.values(playthrough.scenarios).sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id)).map((entry) => { const pinnedGameSetup = localData.gameSetups[entry.gameSetupRevisionId]; return { id: entry.id, label: entry.label, detail: `${SCENARIO_LABELS[entry.kind]} · ${pinnedGameSetup ? `${pinnedGameSetup.label} · revision ${pinnedGameSetup.revision}` : 'Game Setup unavailable'}${entry.gameSetupRevisionId !== gameSetup?.id ? ' · Different from current Game Setup revision' : ''}` } })]} selectedId={playthrough.activeScenarioId ?? NO_SCENARIO} value={scenario?.label ?? 'None selected'}/>}
  </div>
}
