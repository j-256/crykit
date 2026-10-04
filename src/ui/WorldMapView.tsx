import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'
import { BUNDLED_MOD_LIBRARY } from '../catalog/mod-library'
import { loadMapModLayer, loadWorldMap, mapModPinKey, worldMapTargetRef } from '../catalog/world-map'
import { latestGameSetups } from '../domain/game-setups'
import { completeModLibrary } from '../domain/mod-library'
import { normalizeModName } from '../domain/mods'
import { composeWorldMap, filterWorldMarkers, markerSearch, type WorldMapManifest, type WorldMapModLayer, type WorldMarker } from '../domain/world-map'
import type { CatalogSnapshot, LocalData, ModCatalogPin } from '../domain/types'
import { Button, Field, InlineNotice, ScreenHeader } from './components'
import { Sources } from './Sources'
import { Icon } from './icons'
import { useNavigation } from './navigation'
import { ReferenceLink } from './ReferenceLink'
import { MAP_KIND_ICONS, MAP_KIND_LABELS, WorldMapCanvas } from './WorldMapCanvas'
import './world-map.css'

const PREVIEW_SETUP = 'preview'
const RESULT_LIMIT = 80
const ALL_KINDS = Object.keys(MAP_KIND_LABELS) as WorldMarker['kind'][]
const DEFAULT_KINDS = ALL_KINDS.filter(kind => kind !== 'encounter' && kind !== 'sign' && kind !== 'object')
interface ModChoice { readonly key: string; readonly pin: ModCatalogPin; readonly title: string; readonly version?: string; readonly sourceDigest?: string; readonly imported: boolean }
function modChoices(catalogs: readonly CatalogSnapshot[]): readonly ModChoice[] {
  return completeModLibrary(catalogs, BUNDLED_MOD_LIBRARY).flatMap(mod => {
    const choices: ModChoice[] = mod.revisions.map(revision => ({ key: mapModPinKey(revision), pin: revision, title: revision.title, version: revision.declaredVersion, sourceDigest: revision.sourceDigest, imported: true }))
    for (const source of mod.bundled) {
      const pin = { catalogId: source.id, catalogRevisionId: source.sourceDigest as ModCatalogPin['catalogRevisionId'] }
      if (!choices.some(choice => choice.key === mapModPinKey(pin) || choice.sourceDigest === source.sourceDigest)) choices.push({ key: mapModPinKey(pin), pin, title: source.title, version: source.declaredVersion, sourceDigest: source.sourceDigest, imported: false })
    }
    return choices
  })
}
function regionMarker(region: WorldMapManifest['regions'][number]): WorldMarker {
  const sourceId = region.sourceId ?? 'base'
  return { id: `region:${region.id}`, entityId: -1, kind: 'entrance', sourceId, sourceName: region.sourceName ?? 'Base game', sourceRevisionId: region.sourceRevisionId, change: region.change ?? 'base', name: region.name, region: region.name, biomeId: region.id, layer: region.layer, x: region.x, y: 0, z: region.z, description: 'Named map region', targets: [{ family: 'biome', id: region.id, name: region.name, sourceId, sourceRevisionId: region.sourceRevisionId }] }
}
function MarkerSource({ marker }: { readonly marker: WorldMarker }) {
  return <span className={`world-map-source-badge${marker.change === 'base' ? '' : ' world-map-source-badge--mod'}`}><span aria-hidden="true">{marker.change === 'base' ? '◆' : 'M'}</span>{marker.change === 'base' ? 'Vanilla' : marker.sourceName}{marker.change === 'modified' && <small>Modified</small>}</span>
}
function MarkerDetails({ marker, manifest, catalogs, onClose }: { readonly marker: WorldMarker; readonly manifest: WorldMapManifest; readonly catalogs: readonly CatalogSnapshot[]; readonly onClose: () => void }) {
  const navigation = useNavigation()
  const [copyState, setCopyState] = useState('')
  const isRegion = marker.id.startsWith('region:')
  const layerName = manifest.layers.find(layer => layer.id === marker.layer)?.label
  return <section aria-label="Map location details" className="world-map-details">
    <div className="world-map-details__heading"><span className={`world-map-detail-icon world-map-detail-icon--${marker.kind}`}><Icon name={MAP_KIND_ICONS[marker.kind]}/></span><div><p className="eyebrow">{isRegion ? 'Region' : MAP_KIND_LABELS[marker.kind]}</p><h2>{marker.name}</h2></div><button aria-label="Close location details" className="icon-button" onClick={onClose} type="button"><Icon name="close"/></button></div>
    <MarkerSource marker={marker}/>
    <p className="world-map-details__description">{marker.description}</p>
    <dl className="world-map-facts"><div><dt>Location</dt><dd>{marker.region ?? 'Area unrecorded'}</dd></div><div><dt>Layer</dt><dd>{layerName ?? 'Layer unrecorded'}</dd></div><div><dt>Coordinates</dt><dd>X {marker.x} · Z {marker.z}{!isRegion && <small>Height {marker.y}</small>}</dd></div></dl>
    {marker.targets.length > 0 && <div className="world-map-details__references"><h3>{marker.kind === 'chest' ? 'Contents' : marker.kind === 'resource' ? 'Gathered items' : marker.kind === 'boss' || marker.kind === 'encounter' ? 'Encounter' : 'Reference'}</h3>{marker.targets.map(target => {
      const ref = worldMapTargetRef(target, catalogs)
      return <div key={`${target.sourceId}:${target.family}:${target.id}`}>{ref ? <ReferenceLink refValue={ref}>{target.name}</ReferenceLink> : <span>{target.name}</span>}</div>
    })}</div>}
    {marker.conditions && marker.conditions.length > 0 && <div className="world-map-requirements"><h3>Interaction conditions</h3><p>Separate interactions and rewards may use different conditions.</p><ul>{marker.conditions.map((condition, index) => <li key={index}>{condition}</li>)}</ul></div>}
    {marker.warnings && marker.warnings.length > 0 && <InlineNotice title="Some details are unrecorded" tone="warning"><ul>{marker.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></InlineNotice>}
    <p className="world-map-state-note">This is a reference location. Opened chests, defeated bosses, and story progress are not inferred.</p>
    <div className="world-map-details__actions"><Button icon="compass" onClick={() => { void navigator.clipboard.writeText(window.location.href).then(() => setCopyState('Location link copied'), () => setCopyState('Copy the address from your browser to share this location')) }} tone="secondary">Copy location link</Button>{marker.sourceId !== 'base' && <Button icon="tome" onClick={() => navigation.navigate({ page: { page: 'reference', view: 'list' }, overlays: [], query: { 'library-mod': [marker.sourceId] } })} tone="quiet">Browse source mod</Button>}</div>{copyState && <p className="field__hint" role="status">{copyState}</p>}
    <Sources label={`Sources for ${marker.name} location`}><p>{marker.sourceName} · {manifest.source.platform} {manifest.source.gameVersion}</p>{!isRegion && <p>Entity {marker.entityId} · {marker.change === 'base' ? 'Base placement' : marker.change === 'added' ? 'Added by mod' : 'Modified by mod'}</p>}<p>Map terrain retains the bundled native world. Mod exports supply entity and definition changes.</p></Sources>
  </section>
}

export default function WorldMapView({ localData, catalogs }: { readonly localData: LocalData; readonly catalogs: readonly CatalogSnapshot[] }) {
  const navigation = useNavigation()
  const [manifest, setManifest] = useState<WorldMapManifest>()
  const [baseError, setBaseError] = useState('')
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [layers, setLayers] = useState<readonly WorldMapModLayer[]>([])
  const [modLoading, setModLoading] = useState(false)
  const [modError, setModError] = useState('')
  const [query, setQuery] = useState('')
  const [modQuery, setModQuery] = useState('')
  const [kinds, setKinds] = useState<readonly WorldMarker['kind'][]>(DEFAULT_KINDS)
  const [hiddenSources, setHiddenSources] = useState<readonly string[]>([])
  const [visible, setVisible] = useState<readonly WorldMarker[]>([])
  const deferredQuery = useDeferredValue(query)
  const choices = useMemo(() => modChoices(catalogs), [catalogs])
  const setupId = navigation.route.query.gameSetup?.[0] ?? PREVIEW_SETUP
  const setup = setupId === PREVIEW_SETUP ? undefined : localData.gameSetups[setupId]
  const expansion = BUNDLED_MOD_LIBRARY.find(mod => mod.key === 'equipment-expansion')
  const defaultMod = expansion && choices.find(choice => choice.pin.catalogId === expansion.id && choice.sourceDigest === expansion.sourceDigest)
  const previewKeys = navigation.route.query.mods?.[0] === 'none' ? [] : navigation.route.query.mods ?? (defaultMod ? [defaultMod.key] : [])
  const pinKeys = useMemo(() => {
    if (!setup) return setupId === PREVIEW_SETUP ? previewKeys : []
    if (setup.modComposition) return setup.modComposition.layers.filter(layer => layer.enabled).map(mapModPinKey)
    return setup.mods.state === 'known' ? setup.mods.value.flatMap(name => { const matches = choices.filter(choice => normalizeModName(choice.title) === normalizeModName(name)); return matches.length === 1 ? [matches[0]!.key] : [] }) : []
  }, [setup, setupId, JSON.stringify(previewKeys), choices])
  const pins = useMemo(() => pinKeys.flatMap(key => {
    const existing = choices.find(choice => choice.key === key)
    if (existing) return [existing.pin]
    try { const parsed: unknown = JSON.parse(key); if (Array.isArray(parsed) && parsed.length === 2 && parsed.every(value => typeof value === 'string')) return [{ catalogId: parsed[0] as ModCatalogPin['catalogId'], catalogRevisionId: parsed[1] as ModCatalogPin['catalogRevisionId'] }] } catch { /* Invalid URL selections remain unresolved */ }
    return []
  }), [pinKeys, choices])
  const updateQuery = (changes: Readonly<Record<string, readonly string[] | undefined>>) => {
    const next = { ...navigation.route.query }
    for (const [key, value] of Object.entries(changes)) { if (value === undefined) delete next[key]; else next[key] = key === 'mods' && value.length === 0 ? ['none'] : value }
    navigation.navigate({ ...navigation.route, query: next }, { replace: true })
  }
  useEffect(() => {
    let cancelled = false
    setBaseError('')
    void loadWorldMap().then(value => { if (!cancelled) setManifest(value) }, () => { if (!cancelled) setBaseError('The bundled map could not be opened. Retry to load its terrain and locations.') })
    return () => { cancelled = true }
  }, [loadAttempt])
  useEffect(() => {
    let cancelled = false
    setModLoading(true)
    setModError('')
    setLayers([])
    void Promise.all(pins.map(pin => loadMapModLayer(pin, catalogs))).then(value => { if (!cancelled) { setLayers(value); setModLoading(false) } }, () => { if (!cancelled) { setModError('A selected mod source could not be opened. Its placements have not been substituted.'); setModLoading(false) } })
    return () => { cancelled = true }
  }, [pins, catalogs])
  const composed = useMemo(() => manifest ? composeWorldMap(manifest, layers) : undefined, [manifest, layers])
  const layerParameter = Number(navigation.route.query.layer?.[0] ?? 0)
  const validLayer = manifest?.layers.some(layer => layer.id === layerParameter)
  const layerId = validLayer ? layerParameter : 0
  const selectedId = navigation.route.query.marker?.[0]
  const regionMarkers = useMemo(() => composed?.regions.map(regionMarker) ?? [], [composed?.regions])
  const selected = composed?.markers.find(marker => marker.id === selectedId) ?? regionMarkers.find(marker => marker.id === selectedId)
  const sources = useMemo(() => [...new Map((composed?.markers ?? []).map(marker => [marker.sourceId, marker.sourceName])).entries()], [composed?.markers])
  const filterSources = sources.filter(([id]) => !hiddenSources.includes(id)).map(([id]) => id)
  const filtered = useMemo(() => composed ? filterWorldMarkers(composed.markers, { layer: layerId, kinds, sourceIds: filterSources }) : [], [composed, layerId, kinds, JSON.stringify(filterSources)])
  const searching = Boolean(deferredQuery.trim())
  const matches = useMemo(() => searching ? [...regionMarkers.filter(marker => markerSearch(marker, deferredQuery)), ...(composed?.markers ?? []).filter(marker => markerSearch(marker, deferredQuery) && kinds.includes(marker.kind) && !hiddenSources.includes(marker.sourceId))] : visible, [searching, deferredQuery, regionMarkers, composed?.markers, kinds, hiddenSources, visible])
  const results = useMemo(() => [...matches].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)).slice(0, RESULT_LIMIT), [matches])
  const onVisibleChange = useCallback((markers: readonly WorldMarker[]) => setVisible(markers), [])
  const select = (marker: WorldMarker) => updateQuery({ marker: [marker.id], ...(marker.layer === null ? {} : { layer: [String(marker.layer)] }) })
  const toggleMod = (key: string) => {
    const choice = choices.find(value => value.key === key)
    const remaining = pinKeys.filter(value => value !== key && (!choice || choices.find(candidate => candidate.key === value)?.pin.catalogId !== choice.pin.catalogId))
    updateQuery({ gameSetup: undefined, mods: pinKeys.includes(key) ? remaining : [...remaining, key], marker: undefined })
  }
  const reorderMod = (key: string, delta: number) => { const ordered = [...pinKeys]; const index = ordered.indexOf(key); const destination = index + delta; if (index < 0 || destination < 0 || destination >= ordered.length) return; [ordered[index], ordered[destination]] = [ordered[destination]!, ordered[index]!]; updateQuery({ gameSetup: undefined, mods: ordered, marker: undefined }) }
  const configurationWarnings = [
    ...composed?.warnings ?? [],
    ...(setupId !== PREVIEW_SETUP && !setup ? ['The requested Game Setup is unavailable. No mod selections have been inferred.'] : []),
    ...(setup && !setup.modComposition && setup.mods.state === 'known' ? setup.mods.value.flatMap(name => { const matches = choices.filter(choice => normalizeModName(choice.title) === normalizeModName(name)); return matches.length === 1 ? [] : [`${name}: ${matches.length ? 'multiple source revisions match this name' : 'no exact mod source is available'}. Choose its exact revision in the map preview.`] }) : []),
    ...(setup && !setup.modComposition && setup.mods.state !== 'known' ? ['This Game Setup has unrecorded mods. No enabled mod sources have been inferred.'] : []),
    ...(pinKeys.length !== pins.length ? ['A requested mod revision is invalid and could not be opened.'] : []),
    ...(navigation.route.query.layer && !validLayer && manifest ? ['The requested map layer is unavailable. Showing the overworld.'] : []),
  ]
  const presets = latestGameSetups(localData)
  return <div className="world-map-page">
    <ScreenHeader eyebrow="Explore" title="World Map" description="Find the places, people, and treasures behind your next build." actions={<Sources label="Sources for World Map"><p>Terrain and placements: Windows PC {manifest?.source.gameVersion ?? '1.6.9'}. Imported mod changes retain their source revision.</p></Sources>}/>
    <div className="world-map-toolbar"><div className="world-map-search"><Icon name="search"/><input aria-label="Search map" onChange={event => setQuery(event.target.value)} placeholder="Find an item, NPC, boss, or place..." type="search" value={query}/>{query && <button aria-label="Clear map search" onClick={() => setQuery('')} type="button"><Icon name="close"/></button>}</div><Field label="Map layer"><select aria-label="Map layer" onChange={event => updateQuery({ layer: [event.target.value], marker: undefined })} value={layerId}>{manifest?.layers.map(layer => <option key={layer.id} value={layer.id}>{layer.label}</option>) ?? <option value="0">Overworld</option>}</select></Field><Field label="Game Setup"><select aria-label="Game Setup" onChange={event => updateQuery({ gameSetup: event.target.value === PREVIEW_SETUP ? undefined : [event.target.value], marker: undefined })} value={setup?.id ?? PREVIEW_SETUP}><option value={PREVIEW_SETUP}>Map preview</option>{presets.map(value => <option key={value.id} value={value.id}>{value.label}</option>)}{setup && !presets.some(value => value.id === setup.id) && <option value={setup.id}>{setup.label} · r{setup.revision}</option>}</select></Field></div>
    <div aria-label="Map marker filters" className="world-map-kind-filters" role="group">{ALL_KINDS.map(kind => <button aria-pressed={kinds.includes(kind)} className={`world-map-filter world-map-filter--${kind}`} key={kind} onClick={() => setKinds(previous => previous.includes(kind) ? previous.filter(value => value !== kind) : [...previous, kind])} type="button"><Icon name={MAP_KIND_ICONS[kind]}/><span>{MAP_KIND_LABELS[kind]}</span></button>)}</div>
    <details className="world-map-mods"><summary><Icon name="layers"/><span>{setup ? `${setup.label} · pinned mods` : 'Preview mod layers'}</span><strong>{pinKeys.length === 0 ? 'Vanilla' : `${pinKeys.length} enabled`}</strong>{modLoading && <span role="status">Loading...</span>}</summary><div className="world-map-mods__body"><p>{setup ? "The map follows this Game Setup's enabled, ordered source revisions. Preview changes leave the saved setup unchanged." : 'Choose any bundled or imported mod. Later layers take priority. This preview leaves your saved Game Setups unchanged.'}</p><div className="world-map-enabled-mods">{pinKeys.map((key, index) => {
      const choice = choices.find(value => value.key === key)
      return <div className="world-map-enabled-mod" key={key}><span className="world-map-layer-order">{index + 1}</span><span>{choice?.title ?? 'Pinned mod revision'}{choice?.version && <small>v{choice.version}</small>}</span><button aria-label={`Move ${choice?.title ?? 'mod'} earlier`} disabled={index === 0} onClick={() => reorderMod(key, -1)} type="button">↑</button><button aria-label={`Move ${choice?.title ?? 'mod'} later`} disabled={index === pinKeys.length - 1} onClick={() => reorderMod(key, 1)} type="button">↓</button><button aria-label={`Remove ${choice?.title ?? 'mod'} from map preview`} onClick={() => toggleMod(key)} type="button"><Icon name="close"/></button></div>
    })}</div><input aria-label="Search map mods" onChange={event => setModQuery(event.target.value)} placeholder="Find a bundled or imported mod" type="search" value={modQuery}/><div className="world-map-mod-choices">{choices.filter(choice => `${choice.title} ${choice.version ?? ''}`.toLocaleLowerCase().includes(modQuery.trim().toLocaleLowerCase())).map(choice => <label className="world-map-mod-choice" key={choice.key}><input checked={pinKeys.includes(choice.key)} onChange={() => toggleMod(choice.key)} type="checkbox"/><span>{choice.title}<small>{choice.version ? `v${choice.version} · ` : ''}{choice.imported ? 'Imported revision' : 'Bundled source'}</small></span></label>)}</div><Button onClick={() => updateQuery({ gameSetup: undefined, mods: [], marker: undefined })} tone="quiet">Preview vanilla only</Button></div></details>
    {modError && <InlineNotice title="Mod layer unavailable" tone="warning">{modError}</InlineNotice>}
    {configurationWarnings.length > 0 && <details className="world-map-coverage"><summary><Icon name="info"/>Map coverage notes ({configurationWarnings.length})</summary><ul>{configurationWarnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
    {baseError ? <InlineNotice title="Map unavailable" tone="danger">{baseError}<Button onClick={() => setLoadAttempt(value => value + 1)} tone="secondary">Retry world map</Button></InlineNotice> : !manifest || !composed ? <div className="world-map-opening" role="status"><Icon name="compass"/><p>Opening the world...</p></div> : <>
      <div className="world-map-layout"><WorldMapCanvas layerId={layerId} manifest={{ ...manifest, regions: composed.regions }} markers={filtered} onSelect={select} onVisibleChange={onVisibleChange} selected={selected?.layer === layerId && kinds.includes(selected.kind) && !hiddenSources.includes(selected.sourceId) ? selected : undefined}/><aside className="world-map-sidebar">{selected ? <MarkerDetails catalogs={catalogs} key={selected.id} manifest={manifest} marker={selected} onClose={() => updateQuery({ marker: undefined })}/> : <div className="world-map-discover"><Icon name="compass"/><h2>Choose your next discovery</h2><p>Select a marker or search for a place or item. More locations appear as you zoom in.</p><div className="world-map-legend"><span><i className="world-map-legend-dot"/>Vanilla locations</span><span><i className="world-map-legend-dot world-map-legend-dot--mod"/>Mod locations <b>M</b></span></div></div>}
        <div className="world-map-source-filters"><h3>Show sources</h3>{sources.map(([id, name]) => <label key={id}><input checked={!hiddenSources.includes(id)} onChange={() => setHiddenSources(previous => previous.includes(id) ? previous.filter(value => value !== id) : [...previous, id])} type="checkbox"/><span>{id === 'base' ? 'Vanilla' : name}</span></label>)}</div>
      </aside></div>
      {selectedId && !selected && !modLoading && <InlineNotice title="Location unavailable" tone="warning">This marker is not present in the selected source layers.<Button onClick={() => updateQuery({ marker: undefined })} tone="quiet">Clear selection</Button></InlineNotice>}
      <section aria-label="Map location list" className="world-map-results"><header><h2>{searching ? 'Search results' : 'In this view'}</h2><span>{matches.length} {matches.length === 1 ? 'location' : 'locations'}{searching && ' across all layers'}</span></header>{results.length > 0 ? <div className="world-map-result-grid">{results.map(marker => <button aria-label={`Show ${marker.name} on map`} aria-pressed={selected?.id === marker.id} className="world-map-result" key={marker.id} onClick={() => select(marker)} type="button"><span className={`world-map-result__icon world-map-result__icon--${marker.kind}`}><Icon name={MAP_KIND_ICONS[marker.kind]}/></span><span className="world-map-result__copy"><strong>{marker.name}</strong><small>{marker.region ?? 'Area unrecorded'}{marker.layer === null ? ' · Layer unrecorded' : ` · ${manifest.layers.find(layer => layer.id === marker.layer)?.label ?? 'Layer unrecorded'}`}</small></span>{marker.change !== 'base' && <span className="world-map-result__mod" title={marker.sourceName}>M</span>}</button>)}</div> : <p className="world-map-no-results">{searching ? 'No locations match this search and the selected filters.' : 'No selected marker types are in view. Pan, zoom out, or enable another filter.'}</p>}{matches.length > RESULT_LIMIT && <p className="field__hint">Showing the first {RESULT_LIMIT} locations. Narrow your search or zoom into an area to find more.</p>}</section>
      <p className="world-map-footer">Story visibility and other platforms remain unverified.</p>
    </>}
  </div>
}
