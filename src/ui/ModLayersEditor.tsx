import { useId, useMemo, useRef, useState } from 'react'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { composeModLayers, CRYSTAL_EDIT_CATALOG_SCHEMA, MAX_MOD_LAYERS, modCatalogForPin, modCatalogTitle } from '../domain/mod-layers'
import type { CatalogEntity, CatalogSnapshot, EntityId, ModComposition } from '../domain/types'
import { Badge, Button, Field, InlineNotice } from './components'
import { Dropdown } from './Dropdown'
import { useDefinitionLibrary } from './definitions'
import { useOptionalCorrections } from './corrections-context'
import { formatAppError } from './model'
import './mod-layers.css'

const RECORD_PAGE_SIZE = 40
const TARGET_PAGE_SIZE = 40

function revisionLabel(catalog: CatalogSnapshot): string {
  const metadata = catalog.legacy as { projectVersion?: string; editorVersion?: number } | undefined
  return `${metadata?.projectVersion ?? 'Unspecified version'} · editor ${metadata?.editorVersion ?? 'unknown'} · ${catalog.revisionId.slice(-12)}`
}

function TargetPicker({ entity, baseline, target, occupied, onChange }: { entity: CatalogEntity; baseline: CatalogSnapshot; target?: EntityId | null; occupied: readonly EntityId[]; onChange: (id: EntityId | null | undefined) => void }) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const anchor = useRef<HTMLButtonElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const targets = useMemo(() => {
    const search = query.trim().toLocaleLowerCase()
    return Object.values(baseline.entities).filter(value => value.kind === entity.kind && value.name.toLocaleLowerCase().includes(search))
  }, [baseline, entity.kind, query])
  const choose = (id: EntityId | null | undefined) => { onChange(id); setOpen(false); setQuery('') }
  return <div className="mod-target-picker">
    <button aria-controls={id} aria-expanded={open} aria-haspopup="dialog" aria-label={`Bundled target for ${entity.name}`} className="button button--secondary" onClick={() => setOpen(true)} ref={anchor} type="button">{target ? `Replaces ${baseline.entities[target]?.name ?? 'unavailable target'}` : target === null ? 'Keep as a separate definition' : 'Bundled target unresolved'}</button>
    <Dropdown id={id} onDismiss={() => setOpen(false)} anchorRef={anchor} initialFocusRef={input} onClose={() => setOpen(false)} open={open} title={`Link ${entity.name}`}>
      <Field label="Search bundled replacements"><input onChange={event => setQuery(event.target.value)} ref={input} value={query}/></Field>
      <div className="mod-target-picker__choices"><Button onClick={() => choose(null)} tone="quiet" type="button">Keep as a separate definition</Button><Button onClick={() => choose(undefined)} tone="quiet" type="button">Leave bundled target unresolved</Button>{targets.slice(0, TARGET_PAGE_SIZE).map(value => <Button disabled={occupied.includes(value.id)} key={value.id} onClick={() => choose(value.id)} tone="quiet" type="button">{value.name}{occupied.includes(value.id) ? ' (already linked)' : ''}</Button>)}</div>
      {targets.length > TARGET_PAGE_SIZE && <small>Refine the search to see more bundled targets.</small>}
    </Dropdown>
  </div>
}

export function ModLayersEditor({ composition, onChange }: { composition?: ModComposition; onChange: (value: ModComposition) => void }) {
  const library = useDefinitionLibrary()
  const corrections = useOptionalCorrections()
  const catalogs = corrections?.baseline ?? library.catalogs
  const current: ModComposition = useMemo(() => composition ?? { baseline: { catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId }, layers: [], links: [] }, [composition])
  const [project, setProject] = useState('')
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(RECORD_PAGE_SIZE)
  const imported = catalogs.filter(catalog => catalog.schemaVersion === CRYSTAL_EDIT_CATALOG_SCHEMA).sort((left, right) => left.importedAt.localeCompare(right.importedAt))
  const available = imported.filter(catalog => !current.layers.some(layer => layer.catalogId === catalog.id))
  const projectChoices = [...new Map(available.map(catalog => [catalog.id, catalog])).values()]
  const result = useMemo(() => {
    try { return { value: composeModLayers(current, catalogs) } } catch (error) { return { error: formatAppError(error, 'The mod composition could not be resolved.') } }
  }, [catalogs, current])
  const baseline = modCatalogForPin(catalogs, current.baseline)
  const change = (value: ModComposition) => {
    const availableKeys = new Set(value.layers.flatMap(layer => Object.keys(modCatalogForPin(catalogs, layer)?.entities ?? {})))
    onChange({ ...value, links: value.links.filter(link => availableKeys.has(link.modelKey)) })
  }
  const add = () => {
    const chosen = projectChoices.find(catalog => catalog.id === project) ?? projectChoices[0]
    if (!chosen) return
    change({ ...current, layers: [...current.layers, { catalogId: chosen.id, catalogRevisionId: chosen.revisionId, enabled: true }] })
    setProject('')
  }
  const move = (index: number, offset: number) => {
    const layers = [...current.layers]
    ;[layers[index], layers[index + offset]] = [layers[index + offset]!, layers[index]!]
    change({ ...current, layers })
  }
  const records = (result.value?.changes ?? []).filter(value => `${value.entity.name} ${value.modelKey} ${value.sourceTitle}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const unresolved = result.value?.changes.filter(value => value.targetState === 'unresolved').length ?? 0
  return <section aria-label="Imported mod layers" className="stack mod-layers">
    <div className="split"><div><h3>Imported mod layers</h3><p>Enable exact imported versions and arrange their priority. Later enabled layers replace earlier records with the same model family and native ID.</p></div><Badge tone="info">{current.layers.filter(layer => layer.enabled).length} enabled</Badge></div>
    <p className="field__hint">This is the planner's selected priority. Confirm it against your game's mod order. Importing a file alone does not enable it.</p>
    {imported.length === 0 && <InlineNotice title="No imported mod files">Add a Crystal Edit JSON through Import & backup, then return here to enable it.</InlineNotice>}
    {projectChoices.length > 0 && <div className="mod-layers__add"><Field label="Imported mod to add"><select onChange={event => setProject(event.target.value)} value={project || projectChoices[0]!.id}>{projectChoices.map(catalog => <option key={catalog.id} value={catalog.id}>{modCatalogTitle(catalog)}</option>)}</select></Field><Button disabled={current.layers.length >= MAX_MOD_LAYERS} onClick={add} tone="secondary" type="button">Add mod layer</Button></div>}
    <ol aria-label="Mod priority" className="mod-layers__list">{current.layers.map((layer, index) => {
      const catalog = modCatalogForPin(catalogs, layer)
      const title = catalog ? modCatalogTitle(catalog) : layer.catalogId
      return <li className="mod-layers__layer" key={layer.catalogId}>
        <label className="check-row"><input aria-label={`Enable ${title}`} checked={layer.enabled} onChange={event => change({ ...current, layers: current.layers.map((value, position) => position === index ? { ...value, enabled: event.target.checked } : value) })} type="checkbox"/><span><strong>{index + 1}. {title}</strong><small>{layer.enabled ? 'Enabled' : 'Disabled'}{index === current.layers.length - 1 ? ' · highest listed priority' : ''}</small></span></label>
        <Field label={`Revision of ${title}`}><select onChange={event => change({ ...current, layers: current.layers.map((value, position) => position === index ? { ...value, catalogRevisionId: event.target.value as typeof value.catalogRevisionId } : value) })} value={layer.catalogRevisionId}>{imported.filter(value => value.id === layer.catalogId).map(value => <option key={value.revisionId} value={value.revisionId}>{revisionLabel(value)}</option>)}</select></Field>
        <div className="cluster"><Button aria-label={`Move ${title} earlier`} disabled={index === 0} onClick={() => move(index, -1)} tone="quiet" type="button">Earlier</Button><Button aria-label={`Move ${title} later`} disabled={index === current.layers.length - 1} onClick={() => move(index, 1)} tone="quiet" type="button">Later</Button><Button aria-label={`Remove ${title} layer`} onClick={() => change({ ...current, layers: current.layers.filter((_, position) => position !== index) })} tone="quiet" type="button">Remove</Button></div>
      </li>
    })}</ol>
    {result.error && <InlineNotice title="Mod composition needs review" tone="danger">{result.error}{current.links.length > 0 && <Button onClick={() => change({ ...current, links: [] })} tone="secondary" type="button">Clear replacement links</Button>}</InlineNotice>}
    {current.layers.length > 0 && result.value && <>
      <p aria-label="Effective mod summary">{result.value.changes.length} effective imported {result.value.changes.length === 1 ? 'record' : 'records'} · {result.value.changes.filter(value => value.superseded.length).length} with replacements · {unresolved} bundled {unresolved === 1 ? 'target' : 'targets'} unresolved</p>
      {unresolved > 0 && <InlineNotice title="Review bundled replacements">Unlinked records remain separate from bundled entries. Choose a bundled target when the native ID's relationship is known, or deliberately keep the record separate. Names do not establish that relationship.</InlineNotice>}
      {result.value.unresolvedReferences.length > 0 && <InlineNotice title="Definitions still missing">{result.value.unresolvedReferences.slice(0, RECORD_PAGE_SIZE).join(', ')}{result.value.unresolvedReferences.length > RECORD_PAGE_SIZE ? ' and additional references' : ''}. These IDs are absent from all enabled layers; their costs and effects remain unresolved.</InlineNotice>}
      <details><summary>Review effective records and replacement links</summary><div className="stack">
        <Field label="Search effective mod records"><input onChange={event => { setQuery(event.target.value); setLimit(RECORD_PAGE_SIZE) }} value={query}/></Field>
        <ul className="mod-layers__records">{records.slice(0, limit).map(record => <li key={record.modelKey}>
          <div><strong>{record.entity.name}</strong><small>{record.modelKey} · {record.sourceTitle}</small><p>{record.superseded.length ? `Replaces ${record.superseded.join(', ')}` : 'No earlier enabled record with this native identity'}</p></div>
          {baseline && <TargetPicker occupied={current.links.filter(link => link.modelKey !== record.modelKey && link.targetEntityId !== null).map(link => link.targetEntityId!)} baseline={baseline} entity={record.entity} onChange={id => change({ ...current, links: [...current.links.filter(link => link.modelKey !== record.modelKey), ...(id === undefined ? [] : [{ modelKey: record.modelKey, targetEntityId: id }])] })} target={current.links.find(link => link.modelKey === record.modelKey)?.targetEntityId}/>}<details><summary>Winning source record</summary><pre>{JSON.stringify(record.entity.fields['Crystal Edit source record'], null, 2)}</pre></details>
        </li>)}</ul>{records.length > limit && <Button onClick={() => setLimit(value => value + RECORD_PAGE_SIZE)} tone="secondary" type="button">Show more effective records</Button>}{records.length === 0 && <p>No effective imported records match this search.</p>}
      </div></details>
      <InlineNotice title="Supported rules and remaining gaps">Exported class ratings, equipment permissions, native passive costs, and other supported definition fields drive planning. Missing fields stay unknown. Global project settings, unmapped numeric modifier tags, and unsupported battle behavior remain in the source archive. Set the passive PP budget under Advanced Game Setup when needed.</InlineNotice>
      <p className="field__hint">Saving pins this baseline, each chosen revision, and the effective result. Earlier Game Setups, builds, and observations keep their original definitions.</p>
    </>}
  </section>
}
