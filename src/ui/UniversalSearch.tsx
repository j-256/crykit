import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { entityDefinitionKey } from '../domain'
import { modAvailabilityLabel } from '../catalog/mods'
import type { CatalogEntityKind, CatalogSnapshot, EntityRef, Profile } from '../domain/types'
import { Badge, Button, InlineNotice } from './components'
import { DefinitionEditor, definitionKindLabel, useDefinitionWorkspace } from './definitions'
import { Icon } from './icons'
import { routeForSearchTarget, type UniversalSearchTarget } from './search-navigation'
import { Sheet } from './Sheet'
import { routeWithOverlay, useNavigation } from './navigation'

const UNIVERSAL_RESULT_LIMIT = 60
const ALL_DEFINITION_KINDS: readonly CatalogEntityKind[] = ['item', 'class', 'ability', 'passive', 'innate', 'monsterMagic', 'monster', 'command', 'status', 'recipe', 'location', 'other']
const OPEN_PARENT_DIALOG_SELECTOR = 'dialog[open]:not([data-universal-search])'

interface UniversalSearchItem {
  readonly key: string
  readonly title: string
  readonly subtitle: string
  readonly keywords: string
  readonly section: string
  readonly target: UniversalSearchTarget
  readonly preferred?: boolean
}

function definitionName(profile: Profile, optionsByKey: ReadonlyMap<string, string>, ref: EntityRef) {
  const key = entityDefinitionKey(ref)
  return optionsByKey.get(key) ?? (ref.kind === 'personal' ? profile.personalDefinitions[ref.definitionId]?.name : undefined) ?? 'Unresolved definition'
}

function normalize(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase()
}

function itemScore(item: UniversalSearchItem, query: string) {
  const title = normalize(item.title)
  if (title === query) return 0
  if (title.startsWith(query)) return 1
  if (title.includes(query)) return 2
  return 3
}

export function UniversalSearch({ open, catalogs }: { open: boolean; catalogs: readonly CatalogSnapshot[] }) {
  const navigation = useNavigation()
  const { profile, options, availableOptions } = useDefinitionWorkspace()
  const [error, setError] = useState<string>()
  const [createdName, setCreatedName] = useState<string>()
  const searchRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  const searchIndex = navigation.route.overlays.findLastIndex((overlay) => overlay.kind === 'search')
  const searchOverlay = searchIndex >= 0 ? navigation.route.overlays[searchIndex] : undefined
  const query = searchOverlay?.kind === 'search' ? searchOverlay.query : ''
  const editor = searchIndex >= 0 ? navigation.route.overlays[searchIndex + 1] : undefined
  const creating = editor?.kind === 'definition-editor' && editor.mode === 'new'
  const setQuery = (value: string) => {
    if (searchIndex < 0) return
    const overlays = navigation.route.overlays.map((overlay, index) => index === searchIndex ? { kind: 'search' as const, query: value } : overlay)
    navigation.navigate({ ...navigation.route, overlays }, { replace: true })
  }
  const items = useMemo(() => {
    const names = new Map(options.map((option) => [option.key, option.name]))
    const definitions: UniversalSearchItem[] = availableOptions.map((option) => ({ key: `definition:${option.key}`, title: option.name, subtitle: [definitionKindLabel(option.kind), option.sourceLabel, option.modAvailability && modAvailabilityLabel(option.modAvailability)].filter(Boolean).join(' · '), keywords: `${option.aliases.join(' ')} ${option.description ?? ''} ${option.kind} ${option.sourceLabel}`, section: 'Definitions', target: { kind: 'definition', ref: option.ref }, preferred: option.preferred }))
    const inventory: UniversalSearchItem[] = Object.values(profile.inventory).map((position) => ({ key: `inventory:${position.id}`, title: position.observedName ?? definitionName(profile, names, position.ref), subtitle: 'Inventory observation', keywords: `${position.note ?? ''} ${position.possession}`, section: 'Inventory', target: { kind: 'inventory', positionId: position.id } }))
    const characters: UniversalSearchItem[] = Object.values(profile.characters).map((character) => ({ key: `character:${character.id}`, title: character.name, subtitle: 'Character', keywords: character.appearanceLabel ?? '', section: 'Characters', target: { kind: 'character', characterId: character.id } }))
    const builds: UniversalSearchItem[] = Object.values(profile.builds).map((build) => ({ key: `build:${build.id}`, title: build.title, subtitle: 'Build', keywords: `${build.tags.join(' ')} ${build.state}`, section: 'Builds & teams', target: { kind: 'build', buildId: build.id } }))
    const scenarios: UniversalSearchItem[] = Object.values(profile.scenarios).map((scenario) => ({ key: `scenario:${scenario.id}`, title: scenario.label, subtitle: 'Team scenario', keywords: scenario.kind, section: 'Builds & teams', target: { kind: 'scenario', scenarioId: scenario.id } }))
    const progress: UniversalSearchItem[] = Object.values(profile.progress).map((record) => ({ key: `progress:${record.id}`, title: record.displayName, subtitle: 'Party progress', keywords: `${record.stage.state === 'known' ? record.stage.value : ''} ${definitionName(profile, names, record.subject)}`, section: 'Progress', target: { kind: 'progress', recordId: record.id } }))
    return [...definitions, ...inventory, ...characters, ...builds, ...scenarios, ...progress]
  }, [availableOptions, options, profile])
  const results = useMemo(() => {
    const normalizedQuery = normalize(query.trim())
    if (!normalizedQuery) return []
    const tokens = normalizedQuery.split(/\s+/).filter(Boolean)
    return items.filter((item) => tokens.every((token) => normalize(`${item.title} ${item.subtitle} ${item.keywords}`).includes(token))).sort((left, right) => itemScore(left, normalizedQuery) - itemScore(right, normalizedQuery) || Number(right.preferred ?? true) - Number(left.preferred ?? true) || left.title.localeCompare(right.title) || left.key.localeCompare(right.key)).slice(0, UNIVERSAL_RESULT_LIMIT)
  }, [items, query])
  const choose = (target: UniversalSearchTarget) => {
    if (document.querySelector(OPEN_PARENT_DIALOG_SELECTOR)) {
      setError('Finish or discard the open form before navigating to this result.')
      return
    }
    const accepted = navigation.navigate(routeForSearchTarget(target))
    if (!accepted) { setError('Finish or discard the open form before navigating to this result.'); return }
    setError(undefined)
  }
  const focusResult = (direction: 1 | -1, event: KeyboardEvent<HTMLElement>) => {
    const buttons = [...(resultsRef.current?.querySelectorAll<HTMLButtonElement>('button[data-universal-result="true"]') ?? [])]
    if (!buttons.length) return
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = current < 0 ? direction > 0 ? 0 : buttons.length - 1 : (current + direction + buttons.length) % buttons.length
    event.preventDefault()
    buttons[next]?.focus()
  }
  return <>
    <Sheet description="Search definitions and this profile's observations and plans." initialFocusRef={searchRef} layer={searchIndex + 1} onClose={() => { setError(undefined); navigation.close() }} open={open} title="Search Crystal Companion" universalSearch width="command"><div className="universal-search"><div className="search-field universal-search__input"><Icon name="search"/><input aria-label="Search Crystal Companion" onChange={(event) => { setQuery(event.target.value); setError(undefined) }} onKeyDown={(event) => { if (event.key === 'ArrowDown') focusResult(1, event) }} placeholder="Definitions, characters, builds, inventory, teams, or progress" ref={searchRef} type="search" value={query}/><kbd>Esc</kbd></div>
      {error && <InlineNotice title="Navigation blocked" tone="warning">{error} Your search and open draft remain unchanged.</InlineNotice>}
      {createdName && <InlineNotice title="Personal definition created">{createdName} is saved. Select its exact result when you are ready to navigate.</InlineNotice>}
      {!query.trim() ? <div className="universal-search__empty"><Icon name="compass"/><p>Type a name, alias, description, or planner record.</p><small>{catalogs.length} local reference {catalogs.length === 1 ? 'pack' : 'packs'} available</small><Button icon="plus" onClick={() => navigation.navigate(routeWithOverlay(navigation.route, { kind: 'definition-editor', mode: 'new' }))} tone="secondary">Create personal definition</Button></div> : <div className="universal-search__results" onKeyDown={(event) => { if (event.key === 'ArrowDown') focusResult(1, event); if (event.key === 'ArrowUp') focusResult(-1, event) }} ref={resultsRef}>{results.map((item) => <button className="universal-search__result" data-universal-result="true" key={item.key} onClick={() => choose(item.target)} type="button"><span><strong>{item.title}</strong><small>{item.subtitle}</small></span><Badge>{item.section}</Badge></button>)}{results.length === 0 && <InlineNotice title="No matches">Try another term or create a personal definition using this exact search.</InlineNotice>}<Button icon="plus" onClick={() => navigation.navigate(routeWithOverlay(navigation.route, { kind: 'definition-editor', mode: 'new' }))} tone="secondary">Create "{query.trim().slice(0, 80)}"</Button>{results.length === UNIVERSAL_RESULT_LIMIT && <small>Showing the first {UNIVERSAL_RESULT_LIMIT} matches. Refine the search to reach more.</small>}</div>}
    </div></Sheet>
    {creating && <DefinitionEditor allowedKinds={ALL_DEFINITION_KINDS} initialName={query} key={`universal-create:${query}`} onClose={() => navigation.close()} onSaved={() => { const savedName = query.trim() || 'The new definition'; navigation.close(); setCreatedName(savedName); setQuery(savedName) }} open routeIndex={searchIndex + 1}/>}
  </>
}
