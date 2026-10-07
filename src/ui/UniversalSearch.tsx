import { normalizeWeaponType, WEAPON_TYPES } from '../domain/skill-weapons'
import { nativeDefinitionLabel, nativeDisplayName, nativeIdentity, nativeRelationships } from '../domain/native-game'
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { entityDefinitionKey, requirePlaythrough } from '../domain'
import { modListPriority } from '../domain/mods'
import type { DefinitionModAvailability } from '../catalog/mods'
import type { CatalogEntityKind, CatalogSnapshot, EntityRef, LocalData } from '../domain/types'
import { Button, InlineNotice } from './components'
import { DefinitionEditor, definitionKindLabel, useDefinitionLibrary } from './definitions'
import { standingReferenceOptions } from './reference-library'
import { Icon, type IconName } from './icons'
import { DefinitionArtwork } from './GameIcon'
import { routeForSearchTarget, type UniversalSearchTarget } from './search-navigation'
import { Sheet } from './Sheet'
import { routeWithOverlay, useNavigation } from './navigation'
import { ModBadge } from './DefinitionModLabel'
import { preferredDefinitionChoices } from './definition-preferences'
import { starterEntitySourceLabel } from '../catalog/provenance'
import { NavigationLink } from './NavigationLink'
import { useNavigationNotice } from './useNavigationNotice'

const UNIVERSAL_RESULT_LIMIT = 60
const ALL_DEFINITION_KINDS: readonly CatalogEntityKind[] = ['item', 'class', 'ability', 'passive', 'innate', 'monsterMagic', 'monster', 'command', 'status', 'recipe', 'location', 'other']
const OPEN_PARENT_DIALOG_SELECTOR = 'dialog[open]:not([data-universal-search])'
const BLOCKED_NAVIGATION_MESSAGE = 'Finish or discard the open form before navigating to this result.'
const SEARCH_TARGET_ICONS: Readonly<Record<UniversalSearchTarget['kind'], IconName>> = Object.freeze({ weaponSkills: 'sword', definition: 'tome', inventory: 'chest', character: 'character', build: 'sword', team: 'team', scenario: 'compare', progress: 'crystal' })

interface UniversalSearchItem {
  readonly key: string
  readonly title: string
  readonly subtitle: string
  readonly keywords: string
  readonly section: string
  readonly target: UniversalSearchTarget
  readonly artworkRef?: EntityRef
  readonly nativeContext?: string
  readonly preferred?: boolean
  readonly modAvailability?: DefinitionModAvailability
}

function definitionName(localData: LocalData, optionsByKey: ReadonlyMap<string, string>, ref: EntityRef) {
  const key = entityDefinitionKey(ref)
  return optionsByKey.get(key) ?? (ref.kind === 'personal' ? localData.personalDefinitions[ref.definitionId]?.name : undefined) ?? 'Unresolved definition'
}

function normalize(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase()
}

function itemScore(item: UniversalSearchItem, query: string) {
  if (item.target.kind === 'weaponSkills' && normalizeWeaponType(query) === item.target.weapon) return -1
  const title = normalize(item.title)
  if (title === query) return 0
  if (title.startsWith(query)) return 1
  if (title.includes(query)) return 2
  return 3
}

export function UniversalSearch({ open, catalogs }: { open: boolean; catalogs: readonly CatalogSnapshot[] }) {
  const navigation = useNavigation()
  const { localData, options } = useDefinitionLibrary()
  const referenceOptions = useMemo(() => open ? standingReferenceOptions(options, catalogs, localData) : [], [open, options, catalogs, localData])
  const [error, setError] = useState<string>()
  const { noticeRef, revealNotice } = useNavigationNotice()
  const [createdName, setCreatedName] = useState<string>()
  const [includeOtherSources, setIncludeOtherSources] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const restoreFocusRef = useRef(false)
  useLayoutEffect(() => {
    if (open) {
      // Capture the editor control before the search Sheet moves focus into its top layer
      const focused = document.activeElement
      returnFocusRef.current = focused instanceof HTMLElement ? focused : null
    } else if (restoreFocusRef.current) {
      restoreFocusRef.current = false
      if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus({ preventScroll: true })
    }
  }, [open])
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
    if (!open) return []
    const names = new Map(options.map((option) => [option.key, option.name]))
    const snapshots = new Map(catalogs.map(catalog => [JSON.stringify([catalog.id, catalog.revisionId]), catalog]))
    const definitionChoices = includeOtherSources ? referenceOptions : preferredDefinitionChoices(referenceOptions)
    const definitions: UniversalSearchItem[] = definitionChoices.map((option) => {
      const identity = nativeIdentity(option.record)
      const catalog = option.ref.kind === 'catalog' ? snapshots.get(JSON.stringify([option.ref.catalogId, option.ref.catalogRevisionId])) : undefined
      const level = option.record.fields.Level
      const location = identity?.database === 'monster' && catalog ? nativeRelationships(catalog, option.record).find(link => link.label === '/LocationBiomeID')?.name : undefined
      const details = identity ? [identity.database === 'monster' ? level?.state === 'known' ? `Level ${level.value}` : 'Level unresolved' : undefined, location, 'Game data'] : [starterEntitySourceLabel(option.record) ?? option.sourceLabel]
      return { key: `definition:${option.key}`, title: nativeDisplayName(option.record), subtitle: [definitionKindLabel(option.kind), ...details].filter(Boolean).join(' · '), keywords: `${option.aliases.join(' ')} ${option.description ?? ''} ${option.kind} ${option.sourceLabel} ${identity ? `Record #${identity.databaseId} ${nativeDefinitionLabel(option.record)}` : ''} ${option.modAvailability?.requiredMod ?? ''}`, section: 'Definitions', target: { kind: 'definition', ref: option.ref }, artworkRef: option.ref, nativeContext: identity ? [nativeDefinitionLabel(option.record), `Record #${identity.databaseId}`].filter(Boolean).join(' · ') : undefined, preferred: option.preferred, modAvailability: option.modAvailability }
    })
    const inventory: UniversalSearchItem[] = Object.values(requirePlaythrough(localData).inventory).map((position) => ({ key: `inventory:${position.id}`, title: position.observedName ?? definitionName(localData, names, position.ref), subtitle: 'Inventory observation', keywords: `${position.note ?? ''} ${position.possession}`, section: 'Inventory', artworkRef: position.ref, target: { kind: 'inventory', positionId: position.id } }))
    const characters: UniversalSearchItem[] = Object.values(requirePlaythrough(localData).characters).map((character) => ({ key: `character:${character.id}`, title: character.name, subtitle: 'Character', keywords: character.appearanceLabel ?? '', section: 'Characters', target: { kind: 'character', characterId: character.id } }))
    const builds: UniversalSearchItem[] = Object.values(localData.builds).map((build) => ({ key: `build:${build.id}`, title: build.title, subtitle: 'Build', keywords: build.tags.join(' '), section: 'Builds & teams', target: { kind: 'build', buildId: build.id } }))
    const teams: UniversalSearchItem[] = Object.values(localData.teams).map(team => ({ key: `team:${team.id}`, title: team.title, subtitle: 'Team', keywords: team.slots.map(id => id ? localData.builds[localData.buildRevisions[id]?.buildId ?? '']?.title ?? '' : '').join(' '), section: 'Builds & teams', target: { kind: 'team', teamId: team.id } }))
    const scenarios: UniversalSearchItem[] = Object.values(requirePlaythrough(localData).scenarios).map((scenario) => ({ key: `scenario:${scenario.id}`, title: scenario.label, subtitle: 'Party plan', keywords: scenario.kind, section: 'Tracking', target: { kind: 'scenario', scenarioId: scenario.id } }))
    const progress: UniversalSearchItem[] = Object.values(requirePlaythrough(localData).progress).map((record) => ({ key: `progress:${record.id}`, title: record.displayName, subtitle: 'Party progress', keywords: `${record.stage.state === 'known' ? record.stage.value : ''} ${definitionName(localData, names, record.subject)}`, section: 'Progress', target: { kind: 'progress', recordId: record.id } }))
    const skillLists: UniversalSearchItem[] = WEAPON_TYPES.map(weapon => ({ key: `weapon-skills:${weapon}`, title: `Skills usable with ${weapon}`, subtitle: 'Weapon skills · all classes', keywords: `${weapon}s ${weapon === 'Staff' ? 'staves' : ''} weapon skills abilities`, section: 'Skill lists', target: { kind: 'weaponSkills', weapon } }))
    return [...skillLists, ...definitions, ...inventory, ...characters, ...builds, ...teams, ...scenarios, ...progress]
  }, [open, referenceOptions, options, localData, catalogs, includeOtherSources])
  const results = useMemo(() => {
    const normalizedQuery = normalize(query.trim())
    if (!normalizedQuery) return []
    const tokens = normalizedQuery.split(/\s+/).filter(Boolean)
    const matches = items.filter((item) => tokens.every((token) => normalize(`${item.title} ${item.subtitle} ${item.keywords}`).includes(token))).sort((left, right) => modListPriority(left.modAvailability) - modListPriority(right.modAvailability) || itemScore(left, normalizedQuery) - itemScore(right, normalizedQuery) || Number(right.preferred ?? true) - Number(left.preferred ?? true) || left.title.localeCompare(right.title) || left.key.localeCompare(right.key)).slice(0, UNIVERSAL_RESULT_LIMIT)
    const labelCounts = new Map<string, number>()
    for (const item of matches) {
      const key = JSON.stringify([item.title, item.subtitle])
      labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1)
    }
    // Exact native records can share a name; add context after ranking only when labels collide
    return matches.map(item => item.nativeContext && (labelCounts.get(JSON.stringify([item.title, item.subtitle])) ?? 0) > 1 ? { ...item, subtitle: `${item.subtitle} · ${item.nativeContext}` } : item)
  }, [items, query])
  const blockNavigation = () => {
    setError(BLOCKED_NAVIGATION_MESSAGE)
    // The open search dialog owns recovery focus while the underlying editor is inert
    revealNotice()
  }
  const closeSearch = () => {
    setError(undefined)
    // Route-driven closure removes the dialog before its native close can restore focus
    restoreFocusRef.current = true
    if (!navigation.close()) restoreFocusRef.current = false
  }
  const choose = (target: UniversalSearchTarget) => {
    if (document.querySelector(OPEN_PARENT_DIALOG_SELECTOR)) {
      blockNavigation()
      return
    }
    const accepted = navigation.navigate(routeForSearchTarget(target))
    if (!accepted) { blockNavigation(); return }
    setError(undefined)
  }
  const focusResult = (direction: 1 | -1, event: KeyboardEvent<HTMLElement>) => {
    const buttons = [...(resultsRef.current?.querySelectorAll<HTMLElement>('[data-universal-result="true"]') ?? [])]
    if (!buttons.length) return
    const current = buttons.indexOf(document.activeElement as HTMLElement)
    const next = current < 0 ? direction > 0 ? 0 : buttons.length - 1 : (current + direction + buttons.length) % buttons.length
    event.preventDefault()
    buttons[next]?.focus()
  }
  return <>
    <Sheet description="Search definitions and this Playthrough's observations and plans." initialFocusRef={searchRef} layer={searchIndex + 1} onClose={closeSearch} open={open} title="Search CryKit" universalSearch width="command"><div className="universal-search"><div className="search-field universal-search__input"><Icon name="search"/><input aria-label="Search CryKit" onChange={(event) => { setQuery(event.target.value); setError(undefined) }} onKeyDown={(event) => { if (event.key === 'ArrowDown') focusResult(1, event) }} placeholder="Definitions, characters, builds, inventory, teams, or progress" ref={searchRef} type="search" value={query}/><kbd>Esc</kbd></div>
      <label className="check-row universal-search__sources"><input checked={includeOtherSources} onChange={event => setIncludeOtherSources(event.target.checked)} type="checkbox"/><span>Include other sources and mode variants</span></label>
      {error && <div aria-label="Resolve search navigation" ref={noticeRef} role="region" tabIndex={-1}><InlineNotice title="Navigation blocked" tone="warning">{error} Your search and open draft remain unchanged.<div className="cluster"><Button icon="arrow-left" onClick={closeSearch} tone="secondary" type="button">Return to editor</Button></div></InlineNotice></div>}
      {createdName && <InlineNotice title="Custom definition created">{createdName} is saved. Select its exact result when you are ready to navigate.</InlineNotice>}
      {!query.trim() ? <div className="universal-search__empty"><Icon name="compass"/><p>Search for an item, class, character, Build, or Team.</p><Button icon="plus" onClick={() => navigation.navigate(routeWithOverlay(navigation.route, { kind: 'definition-editor', mode: 'new' }))} tone="quiet">Create custom definition</Button></div> : <div className="universal-search__results" onKeyDown={(event) => { if (event.key === 'ArrowDown') focusResult(1, event); if (event.key === 'ArrowUp') focusResult(-1, event) }} ref={resultsRef}>{results.map((item) => <NavigationLink className="universal-search__result" data-universal-result="true" data-mod-state={item.modAvailability?.requiredMod ? item.modAvailability.state : undefined} key={item.key} route={routeForSearchTarget(item.target)} onNavigate={() => choose(item.target)}><span aria-hidden="true" className="universal-search__artwork">{item.artworkRef ? <DefinitionArtwork catalogs={catalogs} localData={localData} value={item.artworkRef}/> : <Icon name={SEARCH_TARGET_ICONS[item.target.kind]}/>}</span><span className="universal-search__copy"><strong>{item.title}</strong><small>{item.subtitle}</small></span><span className="universal-search__result-meta">{item.modAvailability?.requiredMod && <ModBadge name={item.modAvailability.requiredMod} state={item.modAvailability.state}/>}</span></NavigationLink>)}{results.length === 0 && <InlineNotice title="No matches">Try another term or create a custom definition using this exact search.</InlineNotice>}<Button icon="plus" onClick={() => navigation.navigate(routeWithOverlay(navigation.route, { kind: 'definition-editor', mode: 'new' }))} tone="quiet">Create "{query.trim().slice(0, 80)}"</Button>{results.length === UNIVERSAL_RESULT_LIMIT && <small>Showing the first {UNIVERSAL_RESULT_LIMIT} matches. Refine the search to reach more.</small>}</div>}
    </div></Sheet>
    {creating && <DefinitionEditor allowedKinds={ALL_DEFINITION_KINDS} initialName={query} key={`universal-create:${query}`} onClose={() => navigation.close()} onSaved={() => { const savedName = query.trim() || 'The new definition'; navigation.close(); setCreatedName(savedName); setQuery(savedName) }} open routeIndex={searchIndex + 1}/>}
  </>
}
