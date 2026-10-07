import { useEffect, useMemo, useRef, useState } from 'react'
import { loadWorldMap } from '../../catalog/world-map'
import { NATIVE_GAME_DATA } from '../../catalog/native-game'
import { jsonRecord } from '../../domain/crystal-edit'
import { childAt, childCount, objectProperty, parseDocument } from '../../mod-inspector/document'
import { addVoxelPlatform, paintVoxelBlocks, eraseVoxelBlocks, applyMapTextPatch, inspectMapProject, INVALID_VOXEL_ID, MAP_EDITOR_LIMITS, mapTextPatch, moveMapPlacement, type MapPlacement, type PlacementCoord, type TextPatch } from '../../mod-inspector/map-editor'
import type { ParsedDocument } from '../../mod-inspector/types'
import type { WorldMapManifest, WorldMarker } from '../../domain/world-map'
import type { DraftActions, DraftChangeHandler } from '../drafts'
import { Button, Field, InlineNotice, Segmented } from '../components'
import IsometricPlacementView from './IsometricPlacementView'
import MapEditorTools, { isMapShortcut, mapHistoryShortcut, MAP_EDITOR_TOOLS, type MapEditorTool } from './MapEditorTools'
import type { VoxelBrushAction } from './useVoxelBrush'
import { WorldMapCanvas } from '../WorldMapCanvas'
import '../world-map.css'
import './map-editor.css'

const PLACEMENT_PAGE_SIZE = 60
const AXES = ['X', 'Y', 'Z'] as const
const IGNORE_VISIBLE = () => undefined
const KIND_BY_TYPE: Readonly<Record<string, WorldMarker['kind']>> = Object.freeze({ Npc: 'npc', Sign: 'sign', Spark: 'encounter', Door: 'entrance', HomePoint: 'home', Treasure: 'chest', Crystal: 'crystal', Marker: 'object' })
interface History { readonly past: readonly TextPatch[]; readonly future: readonly TextPatch[] }
const EMPTY_HISTORY: History = { past: [], future: [] }
const errorMessage = (reason: unknown) => reason instanceof Error ? reason.message : String(reason)

function projectBiomes(document: ParsedDocument): readonly { id: number; name: string; layer: number | null }[] {
  const biomes = new Map<number, { id: number; name: string; layer: number | null; baseId?: number; mapAlt?: boolean }>()
  const native = NATIVE_GAME_DATA.databases.biome
  if (Array.isArray(native)) for (const record of native) {
    if (jsonRecord(record) && typeof record.ID === 'number' && typeof record.Name === 'string') biomes.set(record.ID, { id: record.ID, name: record.Name, layer: typeof record.MapLayer === 'number' ? record.MapLayer : null, baseId: typeof record.BaseID === 'number' ? record.BaseID : undefined, mapAlt: record.IsMapAlt === true })
  }
  const models = objectProperty(document.root, 'Biomes')
  if (models?.kind === 'array' && childCount(models) > MAP_EDITOR_LIMITS.byteMax + 1) return [...biomes.values()].map(record => ({ ...record, layer: null }))
  const importedIds = new Set<number>()
  if (models?.kind === 'array') for (let index = 0; index < childCount(models); index++) {
    const model = childAt(models, index)!
    const idNode = objectProperty(model, 'ID')
    const nameNode = objectProperty(model, 'Name')
    const layerNode = objectProperty(model, 'MapLayer')
    const id = idNode?.kind === 'number' ? Number(idNode.raw) : NaN
    if (!Number.isInteger(id) || id < 0 || id > MAP_EDITOR_LIMITS.byteMax) continue
    // Duplicate imported IDs cannot borrow either definition's layer or the native fallback
    if (importedIds.has(id)) { biomes.set(id, { id, name: `Ambiguous biome #${id}`, layer: null }); continue }
    importedIds.add(id)
    // Imported biome identities override native records; absent assignments remain unknown
    const layerValue = layerNode?.kind === 'number' ? Number(layerNode.raw) : NaN
    const layer = Number.isInteger(layerValue) && layerValue >= 0 ? layerValue : null
    const baseId = objectProperty(model, 'BaseID')
    biomes.set(id, { id, name: nameNode?.kind === 'string' ? String(nameNode.value) : `Biome #${id}`, layer, baseId: baseId?.kind === 'number' ? Number(baseId.raw) : undefined, mapAlt: objectProperty(model, 'IsMapAlt')?.raw === 'true' })
  }
  return [...biomes.values()].map(record => ({ ...record, layer: record.baseId && !record.mapAlt ? biomes.get(record.baseId)?.layer ?? null : record.layer })).sort((a, b) => a.id - b.id)
}

function marker(placement: MapPlacement, biomes: ReturnType<typeof projectBiomes>, voxelNames: Readonly<Record<string, string>>, manifest?: WorldMapManifest): WorldMarker {
  const biome = biomes.find(record => record.id === placement.biomeId)
  const layer = manifest?.layers.some(record => record.id === biome?.layer) ? biome?.layer ?? null : null
  return { id: `editor:${placement.id}`, entityId: placement.id, sourceId: 'editor', sourceName: 'Working mod', change: 'modified', kind: placement.voxelId === undefined ? KIND_BY_TYPE[placement.type] ?? 'object' : 'object', name: placement.voxelId === undefined ? placement.name : `${voxelNames[String(placement.voxelId)] ?? `Voxel #${placement.voxelId}`} #${placement.id}`, region: biome?.name ?? null, biomeId: placement.biomeId, layer, x: placement.coord.X, y: placement.coord.Y, z: placement.coord.Z, description: 'Authored placement; appearance conditions are not evaluated.', targets: [] }
}

function coordinate(values: Readonly<Record<typeof AXES[number], string>>): PlacementCoord {
  const parsed = Object.fromEntries(AXES.map(axis => [axis, values[axis].trim() ? Number(values[axis]) : NaN])) as unknown as PlacementCoord
  if (!AXES.every(axis => Number.isSafeInteger(parsed[axis]))) throw new Error('Enter an integer for X, height Y and Z before applying the placement.')
  return parsed
}

export default function MapPlacementEditor({ document, disabled, onChange, onDraftChange, onInspect }: { readonly document: ParsedDocument; readonly disabled: boolean; readonly onChange: (next: string, expected: string) => boolean; readonly onDraftChange: DraftChangeHandler; readonly onInspect: (index: number) => void }) {
  const [manifest, setManifest] = useState<WorldMapManifest>()
  const [mapError, setMapError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [layerId, setLayerId] = useState(0)
  const [selectedId, setSelectedId] = useState<number>()
  const [tool, setTool] = useState<MapEditorTool>('paint')
  const [constructionPlane, setConstructionPlane] = useState(false)
  const [view, setView] = useState<'isometric' | 'overview'>('isometric')
  const [picking, setPicking] = useState(false)
  const [showNative, setShowNative] = useState(false)
  const [query, setQuery] = useState('')
  const [voxelQuery, setVoxelQuery] = useState('')
  const [resultLimit, setResultLimit] = useState(PLACEMENT_PAGE_SIZE)
  const [values, setValues] = useState({ X: '0', Y: '', Z: '0' })
  const [biomeId, setBiomeId] = useState('')
  const [voxelId, setVoxelId] = useState('9')
  const [width, setWidth] = useState('2')
  const [depth, setDepth] = useState('2')
  const [dirty, setDirty] = useState(false)
  const [brushSize, setBrushSize] = useState(1)
  const [gesturePending, setGesturePending] = useState(false)
  const [cancelAttempt, setCancelAttempt] = useState(0)
  const [history, setHistory] = useState<History>(EMPTY_HISTORY)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const expectedText = useRef(document.text)
  const draftActionsRef = useRef<DraftActions | undefined>(undefined)
  const registeredActions = useMemo<DraftActions>(() => ({ save: () => draftActionsRef.current?.save() ?? Promise.resolve(false), discard: () => draftActionsRef.current?.discard() }), [])
  const project = useMemo(() => inspectMapProject(document), [document])
  const biomes = useMemo(() => projectBiomes(document), [document])
  const voxelNames = useMemo(() => {
    const source = manifest?.source.voxelNames
    return source && typeof source === 'object' ? Object.fromEntries(Object.entries(source).filter(([id, name]) => Number.isInteger(Number(id)) && Number(id) > 0 && Number(id) < INVALID_VOXEL_ID && typeof name === 'string')) as Record<string, string> : {}
  }, [manifest])
  const voxelOptions = Object.entries(voxelNames).filter(([id, name]) => `${id} ${name}`.toLowerCase().includes(voxelQuery.trim().toLowerCase()) || id === voxelId)
  // A brush default is an authored assignment, not a claim about the clicked native biome
  const layerBiomes = biomes.filter(biome => biome.layer === layerId && biome.id > 0 && biome.name.trim())
  const blockBiomeId = layerBiomes.some(biome => String(biome.id) === biomeId) ? biomeId : String(layerBiomes[0]?.id ?? '')
  const selected = project.placements.find(record => record.id === selectedId)
  const authoredMarkers = useMemo(() => project.placements.map(placement => marker(placement, biomes, voxelNames, manifest)), [project, biomes, voxelNames, manifest])
  const placementIds = useMemo(() => new Set(project.placements.map(placement => placement.id)), [project])
  const markerById = useMemo(() => new Map(authoredMarkers.map(record => [record.entityId, record])), [authoredMarkers])
  const markers = useMemo(() => [...(showNative ? manifest?.markers.filter(record => !placementIds.has(record.entityId)) ?? [] : []), ...authoredMarkers].filter(record => record.layer === layerId), [showNative, manifest, placementIds, authoredMarkers, layerId])
  const isoVisibleIds = useMemo(() => new Set(project.placements.filter(placement => markerById.get(placement.id)?.layer === layerId || placement.id === selectedId && markerById.get(placement.id)?.layer == null).map(placement => placement.id)), [project, markerById, layerId, selectedId])
  const selectedMarker = authoredMarkers.find(record => record.entityId === selectedId && record.layer === layerId)
  const filtered = project.placements.filter(record => `${record.name} ${record.id} ${record.type} ${record.voxelId === undefined ? '' : voxelNames[String(record.voxelId)] ?? record.voxelId}`.toLowerCase().includes(query.trim().toLowerCase()))
  const blocked = disabled || !project.editable
  const previewCoord = AXES.every(axis => values[axis].trim() && Number.isSafeInteger(Number(values[axis]))) ? coordinate(values) : undefined

  useEffect(() => {
    let cancelled = false
    setMapError('')
    void loadWorldMap().then(value => { if (!cancelled) setManifest(value) }).catch(reason => { if (!cancelled) setMapError(errorMessage(reason)) })
    return () => { cancelled = true }
  }, [attempt])
  useEffect(() => {
    if (document.text !== expectedText.current) {
      // JSON edits or recovery can change offsets and identities; never replay stale map patches
      expectedText.current = document.text
      setHistory(EMPTY_HISTORY); setDirty(false); setStatus('Map history cleared after a document change.'); setError('')
    }
  }, [document.text])
  useEffect(() => {
    if (selected && !dirty) setValues(Object.fromEntries(AXES.map(axis => [axis, String(selected.coord[axis])])) as typeof values)
  }, [selected?.id, selected?.coord.X, selected?.coord.Y, selected?.coord.Z, dirty])
  useEffect(() => { onDraftChange(dirty || gesturePending, registeredActions) }, [dirty, gesturePending, registeredActions, onDraftChange])
  useEffect(() => () => onDraftChange(false), [onDraftChange])

  function commit(next: string, label: string, direction?: 'undo' | 'redo') {
    if (blocked) return false
    if (next === document.text) { setDirty(false); return true }
    if (!onChange(next, document.text)) { setError('The draft changed before this edit applied. Select the placement again.'); return false }
    expectedText.current = next
    if (direction) setHistory(previous => direction === 'undo' ? { past: previous.past.slice(0, -1), future: [...previous.future, previous.past.at(-1)!] } : { past: [...previous.past, previous.future.at(-1)!], future: previous.future.slice(0, -1) })
    else {
      const patch = mapTextPatch(document.text, next)
      const past = [...history.past, patch]
      let codeUnits = past.reduce((sum, entry) => sum + entry.before.length + entry.after.length, 0)
      while (past.length > MAP_EDITOR_LIMITS.historyEntries || codeUnits > MAP_EDITOR_LIMITS.historyCodeUnits) { const removed = past.shift()!; codeUnits -= removed.before.length + removed.after.length }
      setHistory({ past, future: [] })
    }
    setDirty(false); setPicking(false); setError(''); setStatus(label)
    return true
  }
  function move() {
    if (!selected) return false
    try { return commit(moveMapPlacement(document.text, selected.id, coordinate(values)), `Moved ${selected.name}.`) }
    catch (reason) { setError(errorMessage(reason)); return false }
  }
  function platformAt(coord: PlacementCoord): string {
    if (!manifest || !blockBiomeId) throw new Error('Choose a biome before adding blocks.')
    return addVoxelPlatform(document.text, { coord, width: Number(width), depth: Number(depth), biomeId: Number(blockBiomeId), voxelId: Number(voxelId), lastNativeEntityId: Number(manifest.source.lastVanillaEntityId), knownVoxelIds: Object.keys(voxelNames).map(Number) })
  }
  function addPlatform() {
    try {
      commit(platformAt(coordinate(values)), `Added ${Number(width) * Number(depth)} voxel blocks. Review the export before trying them in-game.`)
    } catch (reason) { setError(errorMessage(reason)) }
  }
  function applyBrush(action: VoxelBrushAction, coords: readonly PlacementCoord[], ids: readonly number[], expected: string) {
    if (blocked || dirty || !manifest || document.text !== expected) { setError('The draft changed during the brush stroke. Start another stroke.'); return }
    try {
      const boundary = Number(manifest.source.lastVanillaEntityId)
      if (action !== 'erase' && !blockBiomeId) throw new Error('Choose a biome for this map layer before painting.')
      if (action === 'platform' && !coords[0]) throw new Error('Choose a platform destination before placing blocks.')
      // Direct stamps retain the same complete-rectangle overlap rejection as precise authoring
      const next = action === 'platform' ? platformAt(coords[0]!) : action === 'paint' ? paintVoxelBlocks(document.text, coords, { biomeId: Number(blockBiomeId), voxelId: Number(voxelId), lastNativeEntityId: boundary, knownVoxelIds: Object.keys(voxelNames).map(Number) }) : eraseVoxelBlocks(document.text, ids, boundary)
      const count = action !== 'erase' ? inspectMapProject(parseDocument(next)).placements.length - project.placements.length : new Set(ids).size
      if (next === document.text) { setStatus('No blocks changed. Occupied authored cells are skipped.'); return }
      commit(next, action === 'platform' ? `Placed a platform of ${count} blocks. Undo reverses the whole platform.` : action === 'paint' ? `Painted ${count} blocks. Undo reverses the whole stroke.` : `Erased ${count} blocks. Undo restores the whole stroke.`)
    } catch (reason) { setError(errorMessage(reason)) }
  }
  function travel(direction: 'undo' | 'redo') {
    const patch = (direction === 'undo' ? history.past : history.future).at(-1)
    if (!patch || blocked || dirty || gesturePending) return
    try { commit(applyMapTextPatch(document.text, patch, direction), direction === 'undo' ? 'Map edit undone.' : 'Map edit restored.', direction) }
    catch (reason) { setError(errorMessage(reason)) }
  }
  function choose(placement: MapPlacement) {
    if (dirty) { setError('Move the placement or reset its coordinates before choosing another.'); return }
    setSelectedId(placement.id); setTool('move'); setPicking(false); setError('')
    const layer = markerById.get(placement.id)?.layer
    if (layer !== null && layer !== undefined && manifest?.layers.some(record => record.id === layer)) setLayerId(layer)
    setValues(Object.fromEntries(AXES.map(axis => [axis, String(placement.coord[axis])])) as typeof values)
  }
  function chooseTool(next: MapEditorTool) {
    if (blocked || dirty) return
    setCancelAttempt(value => value + 1); setTool(next); setPicking(false); setError('')
  }
  function togglePlane() {
    if (blocked || dirty) return
    setConstructionPlane(tool !== 'paint' || !constructionPlane)
    setView('isometric')
    chooseTool('paint')
  }
  draftActionsRef.current = { save: async () => !gesturePending && (!dirty || move()), discard: () => { setCancelAttempt(value => value + 1); setGesturePending(false); setDirty(false); setError(''); return true } }
  const historyControls = { canUndo: !blocked && !dirty && !gesturePending && !!history.past.length, canRedo: !blocked && !dirty && !gesturePending && !!history.future.length, onUndo: () => travel('undo'), onRedo: () => travel('redo') }

  return <section className="map-editor stack" aria-label="Map Placement Editor" onKeyDown={event => {
    const direction = mapHistoryShortcut(event)
    if (direction && !blocked && !dirty) { event.preventDefault(); travel(direction); return }
    if (!isMapShortcut(event) || blocked || dirty) return
    const next = MAP_EDITOR_TOOLS.find(option => option.shortcut.toLowerCase() === event.key.toLowerCase())
    if (next) { event.preventDefault(); chooseTool(next.value) }
    else if (event.key.toLowerCase() === 'p') { event.preventDefault(); togglePlane() }
  }}>
    <div><h2>Map Placement Editor</h2><p>Paint voxel blocks directly on visible faces, erase added blocks, or move complete imported placements. Preview placements in isometric terrain, drag them on X/Z and adjust their height Y. Appearance conditions and in-game physics are not evaluated.</p></div>
    {!project.editable && <InlineNotice title="This project is available for inspection" tone="warning"><ul>{project.issues.slice(0, PLACEMENT_PAGE_SIZE).map((issue, index) => <li key={index}>{issue}</li>)}</ul><p>Use the JSON Editor tab to review its original fields. Map editing does not convert the source.</p></InlineNotice>}
    {mapError ? <InlineNotice title="Map could not be opened" tone="danger"><p>{mapError}</p><Button tone="secondary" onClick={() => setAttempt(value => value + 1)}>Retry map</Button></InlineNotice> : !manifest && <p role="status">Opening bundled map...</p>}
    {manifest && <>
      <div className="map-editor-toolbar"><Field label="Editor map layer"><select value={layerId} onChange={event => { setCancelAttempt(value => value + 1); setConstructionPlane(false); setLayerId(Number(event.target.value)) }}>{manifest.layers.map(layer => <option key={layer.id} value={layer.id}>{layer.label}</option>)}</select></Field><label className="map-editor-checkbox"><input checked={showNative} onChange={event => setShowNative(event.target.checked)} type="checkbox"/>Show vanilla placements as read-only context</label></div>
      <fieldset className="map-brush-tools" disabled={blocked || dirty}>
        {(tool === 'paint' || tool === 'platform') && <div className="map-brush-palette">
          <Field label="Block voxel"><select value={voxelId} onChange={event => setVoxelId(event.target.value)}>{voxelOptions.map(([id, name]) => <option key={id} value={id}>{name} (#{id})</option>)}</select></Field>
          <Field label="Block biome"><select value={blockBiomeId} onChange={event => { setBiomeId(event.target.value); setCancelAttempt(value => value + 1) }}><option value="">Choose a biome</option>{layerBiomes.map(biome => <option key={biome.id} value={biome.id}>{biome.name} (#{biome.id})</option>)}</select></Field>
          {tool === 'paint' && <Field label="Brush size"><select value={brushSize} onChange={event => setBrushSize(Number(event.target.value))}>{[1, 2, 3, 4].map(size => <option key={size} value={size}>{size} x {size}</option>)}</select></Field>}
          {tool === 'platform' && <><Field label="Platform width X"><input type="number" min={1} max={MAP_EDITOR_LIMITS.brushSide} step={1} value={width} onChange={event => setWidth(event.target.value)}/></Field><Field label="Platform depth Z"><input type="number" min={1} max={MAP_EDITOR_LIMITS.brushSide} step={1} value={depth} onChange={event => setDepth(event.target.value)}/></Field></>}
          <Field label="Search voxel types"><input type="search" value={voxelQuery} onChange={event => setVoxelQuery(event.target.value)} placeholder="Stone, dirt or voxel ID"/></Field>
        </div>}
      </fieldset>
      <Segmented label="Map view" value={view} options={[{ value: 'isometric', label: 'Isometric' }, { value: 'overview', label: 'World map overview' }]} onChange={next => { setView(next); if (next === 'isometric') setPicking(false) }}/>
      {view === 'overview' && <MapEditorTools tool={tool} plane={constructionPlane && tool === 'paint'} history={historyControls} disabled={blocked || dirty} onTool={chooseTool} onPlane={togglePlane}/>}
      <div hidden={view !== 'isometric'}><IsometricPlacementView manifest={manifest} layerId={layerId} placements={project.placements} visibleIds={isoVisibleIds} active={view === 'isometric'} nativeMarkers={markers.filter(record => record.sourceId !== 'editor')} tool={tool} onTool={chooseTool} history={historyControls} constructionPlane={constructionPlane && tool === 'paint'} onPlane={togglePlane} selected={tool === 'move' ? selected : undefined} destination={previewCoord} platformHeight={tool === 'platform' && values.Y.trim() ? Number(values.Y) : undefined} brush={tool === 'paint' || tool === 'platform' ? { width: tool === 'paint' ? brushSize : Number(width), depth: tool === 'paint' ? brushSize : Number(depth), voxelId: Number(voxelId) } : undefined} brushAction={tool === 'platform' ? tool : tool === 'paint' || tool === 'erase' ? tool : undefined} cancelAttempt={cancelAttempt} onBrush={applyBrush} onGestureChange={setGesturePending} disabled={blocked || dirty} source={document.text} onSelect={choose} onDestination={coord => { setValues({ X: String(coord.X), Y: String(coord.Y), Z: String(coord.Z) }); setDirty(tool === 'move' && !!selected) }} onMove={(id, coord, expected) => {
        if (blocked || dirty || document.text !== expected) { setError('The draft changed during this drag. Select the placement again.'); return }
        try { if (commit(moveMapPlacement(document.text, id, coord), `Moved placement #${id}.`)) { setSelectedId(id); setTool('move'); setValues({ X: String(coord.X), Y: String(coord.Y), Z: String(coord.Z) }) } }
        catch (reason) { setError(errorMessage(reason)) }
      }}/></div>
      <div hidden={view !== 'overview'}><WorldMapCanvas manifest={manifest} markers={markers} layerId={layerId} selected={selectedMarker} onVisibleChange={IGNORE_VISIBLE} onSelect={record => {
        const placement = project.placements.find(item => item.id === record.entityId && record.sourceId === 'editor')
        // An armed destination pick must retain its source entity even when the target has a marker
        if (picking && !blocked) { setValues(previous => ({ ...previous, X: String(record.x), Z: String(record.z) })); setDirty(tool === 'move' && !!selected); setPicking(false) }
        else if (placement) choose(placement)
        else setStatus('Vanilla context is read-only. Open a Crystal Edit export containing the complete entity to move it.')
      }} coordinatePick={picking && !blocked ? { label: 'Click or tap a destination cell', onPick: point => { setValues(previous => ({ ...previous, X: String(point.x), Z: String(point.z) })); setDirty(tool === 'move' && !!selected); setPicking(false) } } : undefined}/></div>
      <div className={`map-editor-workspace${tool === 'paint' || tool === 'erase' ? ' map-editor-workspace--brush' : ''}`}>
        <section className="inspector-panel map-editor-placements"><h3>Placements in This Project</h3><Field label="Search editable placements"><input type="search" placeholder="Name, type or entity ID" value={query} onChange={event => { setQuery(event.target.value); setResultLimit(PLACEMENT_PAGE_SIZE) }}/></Field><p>{project.placements.length} authored placements. Vanilla context does not supply complete editable records.</p><div className="map-editor-placement-list">{filtered.slice(0, resultLimit).map(placement => <button key={`${placement.index}:${placement.id}`} type="button" disabled={dirty} aria-pressed={selectedId === placement.id} onClick={() => choose(placement)}><strong>{placement.voxelId === undefined ? placement.name : `${voxelNames[String(placement.voxelId)] ?? 'Voxel'} #${placement.id}`}</strong><small>{placement.type} · ID {placement.id} · X {placement.coord.X}, Y {placement.coord.Y}, Z {placement.coord.Z}</small>{markerById.get(placement.id)?.layer == null && <small>Map layer unknown; use exact coordinates below</small>}</button>)}</div>{filtered.length > resultLimit && <Button tone="quiet" onClick={() => setResultLimit(value => value + PLACEMENT_PAGE_SIZE)}>Show more placements</Button>}{!filtered.length && <p>{project.placements.length ? 'No placements match this search.' : 'Add voxel blocks or open a Crystal Edit export with entity placements.'}</p>}</section>
        <section hidden={tool === 'paint' || tool === 'erase'} className="inspector-panel map-editor-controls"><h3>{tool === 'move' ? selected?.name ?? 'Choose a Placement to Move' : 'Add Voxel Platform'}</h3><fieldset disabled={blocked}>
          <div className="map-editor-coordinates">{AXES.map(axis => <Field key={axis} label={axis === 'Y' ? 'Placement height Y' : `Placement ${axis}`}><input type="number" step={1} min={MAP_EDITOR_LIMITS.intMin} max={MAP_EDITOR_LIMITS.intMax} value={values[axis]} onChange={event => { setValues(previous => ({ ...previous, [axis]: event.target.value })); if (tool === 'move' && selected) setDirty(true) }}/></Field>)}</div>
          <p className="field__hint">These fields support precise placement. The face brush chooses coordinates and height directly on the isometric map.</p><Button tone="secondary" disabled={tool === 'move' && !selected} onClick={() => { setView('overview'); setPicking(value => !value) }}>{picking ? 'Cancel destination pick' : 'Choose destination on map'}</Button>
          {tool === 'move' ? <><p>Moving preserves the entity ID, biome, conditions, contents and every other source field.</p><div className="inspector-actions"><Button disabled={!selected || !dirty} onClick={move}>Move selected placement</Button><Button tone="secondary" disabled={!dirty} onClick={() => { setDirty(false); setError('') }}>Reset coordinates</Button>{selected && <Button tone="quiet" disabled={dirty} onClick={() => onInspect(selected.index)}>Inspect entity JSON</Button>}</div></> : <>
            <p>Click or tap the isometric map to place a platform. Drag to move its preview, then release to add it. Set a height Y here for floating platforms, or leave it blank to use the clicked face. Blocks extend in positive X and Z at one height.</p><Button disabled={gesturePending} onClick={addPlatform}>Add voxel platform</Button>
          </>}
        </fieldset></section>
      </div>
      {error && <InlineNotice title="Map edit was not applied" tone="danger">{error}</InlineNotice>}{status && <p role="status">{status}</p>}
    </>}
  </section>
}
