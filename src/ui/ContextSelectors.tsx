import { useId, useRef, useState, type KeyboardEvent } from 'react'
import type { Profile, ProfileId, RulesetRevisionId, ScenarioId, ScenarioKind } from '../domain/types'
import type { ProfileSummary } from '../interchange/types'
import { Button, InlineNotice } from './components'
import { Dropdown } from './Dropdown'
import { Icon, type IconName } from './icons'
import { activeRuleset, formatAppError, knowledgeLabel } from './model'
import { useNavigation } from './navigation'

const SCENARIO_LABELS: Record<ScenarioKind, string> = { recordedCurrent: 'Recorded current', draft: 'Draft team', hypothetical: 'Hypothetical' }
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

export function ContextSelectors({ profile, profiles, busy, onSelectProfile, onSelectRuleset, onSelectScenario }: { profile: Profile; profiles: readonly ProfileSummary[]; busy: boolean; onSelectProfile: (id: ProfileId) => Promise<void>; onSelectRuleset: (id: RulesetRevisionId) => Promise<void>; onSelectScenario: (id: ScenarioId | null) => Promise<void> }) {
  const navigation = useNavigation()
  const [switching, setSwitching] = useState(false)
  const switchingRef = useRef(false)
  const ruleset = activeRuleset(profile)
  const scenario = profile.activeScenarioId ? profile.scenarios[profile.activeScenarioId] : undefined
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
    <ContextSelector actions={[{ label: 'Manage profiles', run: () => navigation.navigate({ page: { page: 'settings', section: 'data' }, overlays: [], query: {} }) }]} busy={disabled} empty="No saved profiles." hint="Keep build ideas or playthrough records in separate local profiles. Tracking is optional." icon="archive" label="Profile" onSelect={(id) => change(() => onSelectProfile(id as ProfileId))} options={profiles.map((entry) => ({ id: entry.id, label: entry.label, detail: entry.id === profile.id ? 'Active profile' : 'Saved in this browser' }))} selectedId={profile.id} value={profile.label}/>
    <ContextSelector actions={[{ label: 'Configure ruleset', run: () => navigation.navigate({ page: { page: 'settings', section: 'ruleset' }, overlays: [], query: {} }) }]} busy={disabled} empty="No saved rulesets. New builds can start with suggested planning slots." hint="Used for new plans and definition choices. Saved builds and scenarios keep their own rulesets." icon="shield" label="Ruleset" onSelect={(id) => change(() => onSelectRuleset(id as RulesetRevisionId))} options={Object.values(profile.rulesets).sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.revision - left.revision || left.label.localeCompare(right.label) || left.id.localeCompare(right.id)).map((entry) => ({ id: entry.id, label: entry.label, detail: `Revision ${entry.revision} · Platform: ${knowledgeLabel(entry.platform)} · Game version: ${knowledgeLabel(entry.gameVersion)}` }))} selectedId={profile.activeRulesetRevisionId} value={ruleset ? `${ruleset.label} · revision ${ruleset.revision}` : 'Not configured'}/>
    {showScenario && <ContextSelector actions={[{ label: 'Manage scenarios', run: () => navigation.navigate({ page: { page: 'builds', view: 'teams' }, overlays: [], query: {} }) }, { label: 'New scenario', disabled: !ruleset, run: () => navigation.navigate({ page: { page: 'builds', view: 'scenario-new' }, overlays: [], query: {} }) }]} busy={disabled} empty="No scenarios yet." hint="Each team uses its saved ruleset. Selecting a team keeps the active ruleset unchanged." icon="team" label="Scenario" onSelect={(id) => change(() => selectScenario(id))} options={[{ id: NO_SCENARIO, label: 'None selected', detail: 'Leave all saved teams available' }, ...Object.values(profile.scenarios).sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id)).map((entry) => { const pinnedRuleset = profile.rulesets[entry.rulesetRevisionId]; return { id: entry.id, label: entry.label, detail: `${SCENARIO_LABELS[entry.kind]} · ${pinnedRuleset ? `${pinnedRuleset.label} · revision ${pinnedRuleset.revision}` : 'Ruleset unavailable'}${entry.rulesetRevisionId !== profile.activeRulesetRevisionId ? ' · Different from active ruleset' : ''}` } })]} selectedId={profile.activeScenarioId ?? NO_SCENARIO} value={scenario?.label ?? 'None selected'}/>}
  </div>
}
