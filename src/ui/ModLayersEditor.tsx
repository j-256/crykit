import { Sources } from './Sources'
import { useId, useMemo, useRef, useState } from 'react'
import { CURRENT_CATALOG } from '../catalog/bundled'
import { BUNDLED_MOD_LIBRARY } from '../catalog/mod-library'
import { bundledModReplacementLinks, composeModLayers, MAX_MOD_LAYERS, MOD_COMPOSITION_VERSION, modLinkKey, prepareModComposition, modCatalogForPin, modCatalogTitle, modModelRecords, modReplacementKindMatches, nativeModReplacementLinks } from '../domain/mod-layers'
import { originalModIdentity } from '../domain/mod-identities'
import { catalogEntity } from '../domain/entity-identities'
import type { CatalogEntity, CatalogSnapshot, EntityId, ModComposition } from '../domain/types'
import { modLibrary } from '../domain/mod-library'
import { Badge, Button, Field, InlineNotice } from './components'
import { Dropdown } from './Dropdown'
import { useDefinitionLibrary } from './definitions'
import { formatAppError } from './model'
import './mod-layers.css'

const RECORD_PAGE_SIZE = 40
const TARGET_PAGE_SIZE = 40

function revisionLabel(catalog: CatalogSnapshot): string {
  const metadata = catalog.legacy as { projectVersion?: string; editorVersion?: number } | undefined
  return `${metadata?.projectVersion ?? 'Unspecified version'} · editor ${metadata?.editorVersion ?? 'unknown'} · ${catalog.revisionId.replace(/^.*sha256:/, '').split(':')[0]?.slice(0, 12)}`
}

function TargetPicker({ entity, baseline, target, occupied, onChange }: { entity: CatalogEntity; baseline: CatalogSnapshot; target?: EntityId | null; occupied: readonly EntityId[]; onChange: (id: EntityId | null | undefined) => void }) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const anchor = useRef<HTMLButtonElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const targets = useMemo(() => {
    const search = query.trim().toLocaleLowerCase()
    return Object.values(baseline.entities).filter(value => modReplacementKindMatches(value, entity) && value.name.toLocaleLowerCase().includes(search))
  }, [baseline, entity, query])
  const choose = (id: EntityId | null | undefined) => { onChange(id); setOpen(false); setQuery('') }
  return <div className="mod-target-picker">
    <button aria-controls={id} aria-expanded={open} aria-haspopup="dialog" aria-label={`Bundled target for ${entity.name}`} className="button button--secondary" onClick={() => setOpen(true)} ref={anchor} type="button">{target ? `Replaces ${catalogEntity(baseline, target)?.name ?? 'unavailable target'}` : target === null ? 'Keep as a separate definition' : 'Bundled target unresolved'}</button>
    <Dropdown id={id} onDismiss={() => setOpen(false)} anchorRef={anchor} initialFocusRef={input} onClose={() => setOpen(false)} open={open} title={`Link ${entity.name}`}>
      <Field label="Search bundled replacements"><input onChange={event => setQuery(event.target.value)} ref={input} value={query}/></Field>
      <div className="mod-target-picker__choices"><Button onClick={() => choose(null)} tone="quiet" type="button">Keep as a separate definition</Button><Button onClick={() => choose(undefined)} tone="quiet" type="button">Leave bundled target unresolved</Button>{targets.slice(0, TARGET_PAGE_SIZE).map(value => <Button disabled={occupied.includes(value.id)} key={value.id} onClick={() => choose(value.id)} tone="quiet" type="button">{value.name}{occupied.includes(value.id) ? ' (already linked)' : ''}</Button>)}</div>
      {targets.length > TARGET_PAGE_SIZE && <small>Refine the search to see more bundled targets.</small>}
    </Dropdown>
  </div>
}

export function ModLayersEditor({ composition, catalogLock, onChange }: { composition?: ModComposition; catalogLock?: Readonly<Record<string, ModComposition["baseline"]["catalogRevisionId"]>>; onChange: (value: ModComposition) => void }) {
  const library = useDefinitionLibrary()
  const catalogs = library.catalogs
  const baseRevision = catalogLock?.[CURRENT_CATALOG.id] ?? CURRENT_CATALOG.revisionId
  const current: ModComposition = useMemo(() => composition ?? { baseline: { catalogId: CURRENT_CATALOG.id, catalogRevisionId: baseRevision }, layers: [], links: [] }, [composition, baseRevision])
  const [project, setProject] = useState('')
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(RECORD_PAGE_SIZE)
  const mods = modLibrary(catalogs)
  const imported = mods.flatMap(mod => mod.revisions.map(revision => revision.catalog))
  const available = imported.filter(catalog => !current.layers.some(layer => layer.catalogId === catalog.id))
  const projectChoices = [...new Map([...available].reverse().map(catalog => [catalog.id, catalog])).values()]
  const result = useMemo(() => {
    try { return { value: composeModLayers(current, catalogs) } } catch (error) { return { error: formatAppError(error, 'The mod composition could not be resolved.') } }
  }, [catalogs, current])
  const baseline = modCatalogForPin(catalogs, current.baseline)
  const change = (value: ModComposition) => {
    const prepared = prepareModComposition(current, catalogs)
    value = { ...value, version: MOD_COMPOSITION_VERSION, identityMappings: prepared.identityMappings, links: value.links.map(link => {
      const previous = prepared.links.find(candidate => candidate.modelKey === link.modelKey && (link.projectId === undefined || candidate.projectId === link.projectId))
      return previous ? { ...link, ...(previous.projectId ? { projectId: previous.projectId } : {}) } : link
    }) }
    const availableKeys = new Set(value.layers.flatMap(layer => {
      const catalog = modCatalogForPin(catalogs, layer)
      return catalog ? [...modModelRecords(catalog).keys()] : []
    }))
    const links = value.links.filter(link => {
      if (!link.projectId) return availableKeys.has(link.modelKey)
      const layer = value.layers.find(candidate => candidate.catalogId === link.projectId)
      const source = layer && modCatalogForPin(catalogs, layer)
      return source && modModelRecords(source).has(link.modelKey)
    })
    const original = modCatalogForPin(catalogs, value.baseline)
    if (original) for (const layer of value.layers) {
      if (current.layers.some(previous => previous.catalogId === layer.catalogId && previous.catalogRevisionId === layer.catalogRevisionId)) continue
      const incoming = modCatalogForPin(catalogs, layer)
      if (!incoming) continue
      for (const link of [...bundledModReplacementLinks(original, incoming, BUNDLED_MOD_LIBRARY), ...nativeModReplacementLinks(original, incoming)]) {
        if (!links.some(previous => modLinkKey(previous) === modLinkKey(link) || previous.targetEntityId === link.targetEntityId)) links.push(link)
      }
    }
    onChange(prepareModComposition({ ...value, links }, catalogs))
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
    <div className="split"><div><h3>Imported mod layers</h3><p>Choose imported mod versions and set their order. Later mods take priority when changing the same base-game record. Added records stay linked to their source project.</p></div><Badge tone="info">{current.layers.filter(layer => layer.enabled).length} enabled</Badge></div>
    <p className="field__hint">Match this order to your game. Importing a mod does not enable it. CryKit suggests replacement links from record types and IDs; review them below.</p>
    {composition && composition.version !== MOD_COMPOSITION_VERSION && <InlineNotice title="Mod ID mapping">Editing layers upgrades this setup's mod ID mapping. Earlier Game Setups stay unchanged.</InlineNotice>}
    {imported.length === 0 && <InlineNotice title="No imported mod files">Save a Crystal Edit JSON from the Mods editor to CryKit, then select its version here.</InlineNotice>}
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
      {unresolved > 0 && <InlineNotice title="Review bundled replacements">Link a record to a bundled entry only when you have confirmed its ID. Matching names are not enough. Unlinked records stay separate.</InlineNotice>}
      {result.value.unresolvedReferences.length > 0 && <InlineNotice title="Definitions still missing">{result.value.unresolvedReferences.slice(0, RECORD_PAGE_SIZE).join(', ')}{result.value.unresolvedReferences.length > RECORD_PAGE_SIZE ? ' and additional references' : ''}. These IDs are absent from all enabled layers; their costs and effects remain unresolved.</InlineNotice>}
      <details><summary>Review effective records and replacement links</summary><div className="stack">
        <Field label="Search effective mod records"><input onChange={event => { setQuery(event.target.value); setLimit(RECORD_PAGE_SIZE) }} value={query}/></Field>
        <ul className="mod-layers__records">{records.slice(0, limit).map(record => {
          const modelKey = record.originalModelKey ?? record.modelKey
          const [, family, originalId] = modelKey.split(':')
          const link = { modelKey, ...(current.version === MOD_COMPOSITION_VERSION && !originalModIdentity(family!, Number(originalId)) ? { projectId: record.identityProjectId ?? record.source.catalogId } : {}) }
          const key = modLinkKey(link)
          return <li key={record.modelKey}>
          <div><Sources anchor={<strong>{record.entity.name}</strong>} label={`Sources for ${record.entity.name} winning record`}><pre>{JSON.stringify(record.entity.fields['Crystal Edit source record'], null, 2)}</pre></Sources><small>{record.entity.id} · {record.sourceTitle}</small><p>{record.superseded.length ? `Replaces ${record.superseded.join(', ')}` : 'No earlier enabled record with this native identity'}</p></div>
          {baseline && <TargetPicker occupied={current.links.filter(link => modLinkKey(link) !== key && link.targetEntityId !== null).map(link => link.targetEntityId!)} baseline={baseline} entity={record.entity} onChange={id => change({ ...current, links: [...current.links.filter(link => modLinkKey(link) !== key), ...(id === undefined ? [] : [{ ...link, targetEntityId: id }])] })} target={current.links.find(link => modLinkKey(link) === key)?.targetEntityId ?? (record.targetState === 'separate' ? null : undefined)}/>}
        </li>})}</ul>{records.length > limit && <Button onClick={() => setLimit(value => value + RECORD_PAGE_SIZE)} tone="secondary" type="button">Show more effective records</Button>}{records.length === 0 && <p>No effective imported records match this search.</p>}
      </div></details>
      <InlineNotice title="Supported rules and remaining gaps">Planning uses supported class, equipment, passive, battle, and difficulty data from these mod versions. Missing fields, unrecognized modifiers, and unsupported battle behavior stay unknown.</InlineNotice>
      <p className="field__hint">Saving keeps these exact source versions. Earlier Game Setups, Builds, and observations keep their definitions.</p>
    </>}
  </section>
}
