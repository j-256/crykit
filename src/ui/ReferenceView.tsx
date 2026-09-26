import { modAvailabilityLabel } from '../catalog/mods'
import { useCallback, useMemo, useState } from 'react'
import { entityDefinitionKey, preferredDefinitionRef } from '../domain'
import type { CatalogClaim, CatalogSnapshot, EntityRef, JsonValue, Knowledge, Profile, RulesetRevisionId, SourceRef } from '../domain/types'
import { Badge, BoundedFacetOptions, Button, EmptyState, InlineNotice, ScreenHeader } from './components'
import { Icon } from './icons'
import { formatAppError, knowledgeTone } from './model'
import { DefinitionEditor, findDefinitionOption, useDefinitionWorkspace, type DefinitionOption } from './definitions'
import { routeWithOverlay, useNavigation, type ReferencePageRoute } from './navigation'
import { Sheet } from './Sheet'
import { sourceDisplay } from './source-display'
import {
  aggregateKnowledgeCounts,
  buildFacetOptions,
  buildReferenceSearchItems,
  partitionPersonalDefinitionOptions,
  partitionReferenceItems,
  personalDefinitionCategoryValues,
  type ReferenceSearchItem,
} from './search'
import {
  commitReferenceRouteState,
  readReferenceRouteState,
  REFERENCE_PAGE_SIZE,
  ROUTE_MAX_RESULT_LIMIT,
  type ReferenceRouteState,
} from './route-state'

function referenceDefinitionKey(item: ReferenceSearchItem): string {
  return entityDefinitionKey({ kind: 'catalog', catalogId: item.catalog.id, catalogRevisionId: item.catalog.revisionId, entityId: item.entity.id })
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function StructuredValue({ value }: { value: unknown }) {
  if (value === null) return <span>Null</span>
  if (typeof value === 'string') return <span className="structured-value__text">{value}</span>
  if (typeof value === 'number' || typeof value === 'boolean') return <span>{String(value)}</span>
  if (Array.isArray(value)) {
    if (value.length === 0) return <span>None</span>
    if (value.every(isRecord)) {
      const columns = Array.from(new Set(value.flatMap((row) => Object.keys(row))))
      return <div className="structured-value__table"><table><thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{value.map((row, rowIndex) => <tr key={rowIndex}>{columns.map((column) => <td key={column}><StructuredValue value={row[column]}/></td>)}</tr>)}</tbody></table></div>
    }
    return <ul className="structured-value__list">{value.map((entry, index) => <li key={index}><StructuredValue value={entry}/></li>)}</ul>
  }
  if (isRecord(value)) return <dl className="structured-value__record">{Object.entries(value).map(([name, nested]) => <div key={name}><dt>{name}</dt><dd><StructuredValue value={nested}/></dd></div>)}</dl>
  return <span>{String(value)}</span>
}

function KnowledgeValue({ value }: { value: Knowledge<unknown> }) {
  if (value.state === 'known') return <StructuredValue value={value.value}/>
  if (value.state === 'conflicting') return <span>{value.claims.length} conflicting claims</span>
  if (value.state === 'notApplicable') return <span>{value.reason ?? 'Not applicable'}</span>
  return <span>{value.reason ?? 'Unknown'}</span>
}

function sourceHref(source: SourceRef): string | undefined {
  for (const candidate of [source.locator, source.sourceId]) {
    if (!candidate) continue
    try {
      const url = new URL(candidate)
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.href
    } catch {
      // Plain source identifiers remain visible without becoming links
    }
  }
  return undefined
}

function SourceSummary({ source }: { source: SourceRef }) {
  const href = sourceHref(source)
  const display = sourceDisplay(source.sourceId)
  return <><strong>{display.label}</strong><p>{source.locator ?? source.sourceId}</p><small>{display.detail ? `${display.detail} · ` : ''}{source.applicability ?? 'Applicability not stated'}{href ? <> · <a href={href} rel="noreferrer noopener" target="_blank">Open source</a></> : null}</small></>
}

function ClaimValue({ value }: { value: Knowledge<JsonValue> }) {
  if (value.state !== 'conflicting') return <div><KnowledgeValue value={value}/></div>
  return <div className="stack">{value.claims.map((claim, index) => <div key={index}><StructuredValue value={claim.value}/><small>{claim.note ?? 'Conflicting source value'}{claim.sources.length ? ` · ${claim.sources.map((source) => source.sourceId).join(' · ')}` : ''}</small></div>)}</div>
}

function ClaimTrail({ claim }: { claim: CatalogClaim }) {
  return <div className="source-claim"><span className="source-claim__line"/><div><strong>{claim.field}</strong><ClaimValue value={claim.value}/><small>{claim.sources.length ? claim.sources.map((source) => { const href = sourceHref(source); const display = sourceDisplay(source.sourceId); return href ? <span className="source-reference" key={`${source.sourceId}:${source.locator ?? ''}`} title={source.sourceId}><a href={href} rel="noreferrer noopener" target="_blank">{display.label}</a>{source.locator && source.locator !== href ? `: ${source.locator}` : ''} </span> : <span className="source-reference" key={`${source.sourceId}:${source.locator ?? ''}`}>{display.label}{source.locator ? `: ${source.locator}` : ''} </span> }) : 'No source locator supplied'}</small></div></div>
}

function toggleValue(values: readonly string[], value: string): readonly string[] {
  return values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value]
}

function numericInput(value: string): number | undefined {
  if (value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function ppLabel(item: ReferenceSearchItem): string {
  if (item.ppCost.state === 'known') return `${item.ppCost.value} PP`
  if (item.ppCost.state === 'conflicting') return 'PP conflict'
  if (item.ppCost.state === 'unknown') return 'PP unknown'
  return 'PP n/a'
}

function DetailView({ item, onBack, onEdit }: { item: ReferenceSearchItem; onBack: () => void; onEdit: () => void }) {
  const planningFields: readonly [string, Knowledge<unknown> | undefined][] = [
    ['Slot kinds', item.entity.slotKinds],
    ['Occupied slots', item.entity.occupiesSlots],
    ['PP cost', item.entity.ppCost],
    ['Requirements', item.entity.requirements],
    ['Grants', item.entity.grants],
    ['Listed contributions', item.entity.listedContributions ? { state: 'known', value: item.entity.listedContributions } : undefined],
  ]
  return <div className="panel__body stack">
    <div className="split"><Button icon="arrow-left" onClick={onBack} tone="quiet">Back to results</Button><Button icon="edit" onClick={onEdit} tone="secondary">Edit as personal override</Button></div>
    <div><div className="reference-card__meta"><Badge tone="info">{item.entity.kind}</Badge><Badge>{item.catalog.id}</Badge><Badge tone={knowledgeTone(item.catalog.applicability)}>{item.catalog.applicability.state === 'known' ? item.catalog.applicability.value : 'Applicability unknown'}</Badge>{item.knowledgeCounts.conflicting > 0 && <Badge tone="danger">{item.knowledgeCounts.conflicting} conflicts</Badge>}</div><h2>{item.entity.name}</h2><p>{item.entity.rawDescription ?? 'No raw description supplied.'}</p>{item.entity.aliases.length > 0 && <small>Aliases: {item.entity.aliases.join(', ')}</small>}</div>
    <div className="grid-2">
      <div className="panel"><div className="panel__header"><h3>Normalized fields</h3></div><div className="panel__body">{Object.keys(item.entity.fields).length ? <dl className="definition-list">{Object.entries(item.entity.fields).map(([field, value]) => <div className="definition-row" key={field}><dt>{field}</dt><dd><KnowledgeValue value={value}/> <Badge tone={knowledgeTone(value)}>{value.state}</Badge></dd></div>)}</dl> : <InlineNotice title="No normalized fields">Identity and source claims may still contain useful source details.</InlineNotice>}</div></div>
      <div className="panel"><div className="panel__header"><h3>Source trail</h3></div><div className="panel__body">{item.entity.sources.length ? item.entity.sources.map((source, index) => <div className="source-claim" key={`${source.sourceId}:${source.locator ?? ''}:${index}`}><span className="source-claim__line"/><div><SourceSummary source={source}/></div></div>) : <InlineNotice title="No entity sources">Inspect the catalog pack provenance before relying on this definition.</InlineNotice>}</div></div>
    </div>
    <div className="panel"><div className="panel__header"><div><h3>Planning fields</h3><p>Normalized validation values remain separate from descriptive wiki facts</p></div></div><div className="panel__body"><dl className="definition-list">{planningFields.map(([field, value]) => <div className="definition-row" key={field}><dt>{field}</dt><dd>{value ? <><KnowledgeValue value={value}/> <Badge tone={knowledgeTone(value)}>{value.state}</Badge></> : 'Not supplied'}</dd></div>)}</dl></div></div>
    <div className="panel"><div className="panel__header"><div><h3>Imported claims</h3><p>Original auxiliary stats, locations, growth data, and unresolved source values</p></div></div><div className="panel__body">{item.claims.length ? item.claims.map((claim, index) => <ClaimTrail claim={claim} key={`${claim.field}:${index}`}/>) : <InlineNotice title="No separate claims">This definition did not include auxiliary or conflicting source claims.</InlineNotice>}</div></div>
  </div>
}

function PersonalDetail({ option, onBack, onEdit }: { option: DefinitionOption; onBack: () => void; onEdit: () => void }) {
  const definition = option.record
  return <div className="panel__body stack">
    <div className="split"><Button icon="arrow-left" onClick={onBack} tone="quiet">Back to results</Button><Button icon="edit" onClick={onEdit} tone="secondary">Edit definition</Button></div>
    <div><div className="reference-card__meta"><Badge tone="info">{option.kind}</Badge><Badge>Personal definition</Badge><Badge tone={option.preferred ? 'positive' : 'warning'}>{option.preferred ? 'Preferred revision' : 'Historical revision'}</Badge></div><h2>{option.name}</h2><p>{option.description ?? 'No description supplied.'}</p>{option.aliases.length > 0 && <small>Aliases: {option.aliases.join(', ')}</small>}</div>
    <InlineNotice title="Immutable definition history">Edits create a new personal revision. Inventory observations, learning records, and build checkpoints keep their exact saved reference.</InlineNotice>
    <div className="grid-2"><div className="panel"><div className="panel__header"><h3>Recorded fields</h3></div><div className="panel__body">{Object.keys(definition.fields).length ? <dl className="definition-list">{Object.entries(definition.fields).map(([field, value]) => <div className="definition-row" key={field}><dt>{field}</dt><dd><KnowledgeValue value={value}/> <Badge tone={knowledgeTone(value)}>{value.state}</Badge></dd></div>)}</dl> : <InlineNotice title="No recorded fields">Unrecorded fields remain unknown.</InlineNotice>}</div></div><div className="panel"><div className="panel__header"><h3>Lineage</h3></div><div className="panel__body"><dl className="definition-list"><div className="definition-row"><dt>Exact identity</dt><dd>{option.key}</dd></div><div className="definition-row"><dt>Revision</dt><dd>{'revision' in definition ? definition.revision : 'Catalog base'}</dd></div>{'baseRef' in definition && definition.baseRef && <div className="definition-row"><dt>Based on</dt><dd>{entityDefinitionKey(definition.baseRef)}</dd></div>}{'previousRevision' in definition && definition.previousRevision && <div className="definition-row"><dt>Previous revision</dt><dd>{entityDefinitionKey(definition.previousRevision)}</dd></div>}<div className="definition-row"><dt>Source</dt><dd>{option.sourceLabel}</dd></div></dl></div></div></div>
  </div>
}

function mergeFacetOptions(base: readonly { readonly value: string; readonly count: number }[], additions: readonly string[]) {
  const counts = new Map(base.map((option) => [option.value, option.count]))
  for (const value of additions) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts].map(([value, count]) => ({ value, count })).sort((left, right) => left.value.localeCompare(right.value))
}

export function ReferenceView({ profile, catalogs, onOpenData, onPromoteDefinitions }: { profile: Profile; catalogs: readonly CatalogSnapshot[]; onOpenData: () => void; onPromoteDefinitions: (sourceRulesetRevisionId: RulesetRevisionId, definitionRefs: readonly EntityRef[], label: string) => Promise<void> }) {
  const navigation = useNavigation()
  const { options, availableOptions } = useDefinitionWorkspace()
  const route = readReferenceRouteState()
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [promotionRefs, setPromotionRefs] = useState<readonly EntityRef[]>([])
  const [promotionRulesetId, setPromotionRulesetId] = useState<RulesetRevisionId | ''>(profile.activeRulesetRevisionId ?? '')
  const [promotionLabel, setPromotionLabel] = useState('Reviewed personal definitions')
  const [promotionBusy, setPromotionBusy] = useState(false)
  const [promotionError, setPromotionError] = useState<string>()
  const items = useMemo(() => buildReferenceSearchItems(catalogs), [catalogs])
  const optionsByKey = useMemo(() => new Map(options.map(option => [option.key, option])), [options])
  const availableKeys = useMemo(() => new Set(availableOptions.map(option => option.key)), [availableOptions])
  const searchableItems = useMemo(() => items.filter(item => availableKeys.has(referenceDefinitionKey(item))), [availableKeys, items])
  const availablePersonalOptions = useMemo(() => availableOptions.filter(option => option.ref.kind === 'personal'), [availableOptions])
  const personalOptions = useMemo(() => options.filter((option) => option.ref.kind === 'personal'), [options])
  const preferredPersonalOptions = useMemo(() => personalOptions.filter((option) => option.preferred), [personalOptions])
  const kindOptions = useMemo(() => mergeFacetOptions(buildFacetOptions(searchableItems, 'kind'), availablePersonalOptions.map((option) => option.kind)), [searchableItems, availablePersonalOptions])
  const categoryOptions = useMemo(() => mergeFacetOptions(buildFacetOptions(searchableItems, 'category'), availablePersonalOptions.flatMap(personalDefinitionCategoryValues)), [searchableItems, availablePersonalOptions])
  const sourceOptions = useMemo(() => mergeFacetOptions(buildFacetOptions(searchableItems, 'source'), availablePersonalOptions.map(() => 'Personal definitions')), [searchableItems, availablePersonalOptions])
  const partition = useMemo(() => partitionReferenceItems(searchableItems, {
    query: route.query,
    kinds: route.kinds,
    categories: route.categories,
    sources: route.sources,
    ...(route.ppMin === undefined && route.ppMax === undefined ? {} : { pp: { min: route.ppMin, max: route.ppMax, unit: 'PP' } }),
  }), [searchableItems, route.categories, route.kinds, route.ppMax, route.ppMin, route.query, route.sources])
  const results = useMemo(() => [...partition.confirmed, ...partition.possible], [partition.confirmed, partition.possible])
  const personalPartition = useMemo(() => partitionPersonalDefinitionOptions(availablePersonalOptions, {
    query: route.query,
    kinds: route.kinds,
    categories: route.categories,
    sources: route.sources,
    ...(route.ppMin === undefined && route.ppMax === undefined ? {} : { pp: { min: route.ppMin, max: route.ppMax, unit: 'PP' } }),
  }), [availablePersonalOptions, route.categories, route.kinds, route.ppMax, route.ppMin, route.query, route.sources])
  const personalResults = useMemo(() => [...personalPartition.confirmed, ...personalPartition.possible], [personalPartition.confirmed, personalPartition.possible])
  const visiblePersonalResults = personalResults.slice(0, route.resultLimit)
  const visibleCatalogResults = results.slice(0, Math.max(0, route.resultLimit - visiblePersonalResults.length))
  const totalResults = personalResults.length + results.length
  const page = navigation.route.page.page === 'reference' ? navigation.route.page : { page: 'reference', view: 'list' } as const
  const selectedRef = page.view === 'detail' ? page.ref : undefined
  const selected = selectedRef?.kind === 'catalog' ? items.find((item) => item.catalog.id === selectedRef.catalogId && item.catalog.revisionId === selectedRef.catalogRevisionId && item.entity.id === selectedRef.entityId) : undefined
  const selectedPersonal = selectedRef?.kind === 'personal' ? findDefinitionOption(options, selectedRef) : undefined
  const selectedAvailability = selectedRef ? optionsByKey.get(entityDefinitionKey(selectedRef))?.modAvailability : undefined
  const missingDetail = page.view === 'detail' && !selected && !selectedPersonal
  const promoting = page.view === 'promote'
  const editorOverlay = navigation.route.overlays[0]
  const editingRef = editorOverlay?.kind === 'definition-editor' && editorOverlay.mode === 'override' ? editorOverlay.ref : undefined
  const editingOption = editingRef ? findDefinitionOption(options, editingRef) : undefined
  const missingEditingRef = Boolean(editingRef && !editingOption)
  const knowledgeCounts = useMemo(() => aggregateKnowledgeCounts(results), [results])
  const rulesets = Object.values(profile.rulesets).sort((left, right) => right.createdAt.localeCompare(left.createdAt))

  const updateRoute = useCallback((change: Partial<ReferenceRouteState>, mode: 'push' | 'replace' = 'replace') => {
    commitReferenceRouteState({ ...route, ...change }, mode)
  }, [route])

  const updateFilter = useCallback((change: Partial<ReferenceRouteState>, mode: 'push' | 'replace' = 'replace') => {
    updateRoute({ ...change, selectedKey: undefined, resultLimit: REFERENCE_PAGE_SIZE }, mode)
  }, [updateRoute])

  const navigate = (next: ReferencePageRoute, replace = false) => navigation.navigate({ ...navigation.route, page: next, overlays: [] }, { replace })
  const openDetail = (ref: EntityRef) => navigate({ page: 'reference', view: 'detail', ref })

  const promote = async () => {
    if (!promotionRulesetId || !promotionRefs.length || !promotionLabel.trim()) return
    setPromotionBusy(true)
    setPromotionError(undefined)
    try {
      await onPromoteDefinitions(promotionRulesetId, promotionRefs, promotionLabel.trim())
      setPromotionRefs([])
      navigation.close()
    } catch (reason) {
      setPromotionError(formatAppError(reason, 'The ruleset revision could not be created.'))
    } finally {
      setPromotionBusy(false)
    }
  }

  return <>
    <ScreenHeader actions={<><Button disabled={!preferredPersonalOptions.length || !rulesets.length} icon="layers" onClick={() => { setPromotionRefs(preferredPersonalOptions.map((option) => option.ref)); navigate({ page: 'reference', view: 'promote' }) }} tone="secondary">Collect into ruleset revision</Button><Button icon="upload" onClick={onOpenData} tone="secondary">Import reference</Button></>} description="Look up equipment, classes, abilities, and monsters. Check sources and unknown details before planning." eyebrow="Game reference" title="Reference"/>
    {!selectedRef && availableOptions.length < options.length && <p className="settings-section__intro">Definitions from explicitly disabled mods are hidden. Unclassified entries and uncertain mod settings remain visible.</p>}
    {selectedAvailability?.requiredMod && <p className="settings-section__intro">{modAvailabilityLabel(selectedAvailability)}</p>}
    {missingDetail && <InlineNotice title="Reference definition unavailable" tone="warning">The requested exact definition is not available in this workspace. It may belong to another catalog revision, an older backup, or another playthrough. <Button onClick={() => navigate({ page: 'reference', view: 'list' })} tone="quiet">Return to reference</Button></InlineNotice>}
    {catalogs.length === 0 && personalOptions.length === 0 ? <EmptyState aside={<>Personal records remain available even if a local reference pack cannot be loaded.</>} description="No reference pack is available in this workspace. Import a permitted pack locally and review its format, rights, and coverage before adding it." icon="book" title="Reference library is empty"><Button icon="upload" onClick={onOpenData}>Import a reference pack</Button></EmptyState> : <div className="reference-layout">
      <aside className="panel facet-panel">
        <div className="panel__header"><div><h2>Refine</h2><p>{partition.confirmed.length + personalPartition.confirmed.length} confirmed · {partition.possible.length + personalPartition.possible.length} possible</p></div></div>
        <div className="facet-group"><div className="search-field"><Icon name="search"/><input aria-label="Search reference" onChange={(event) => updateFilter({ query: event.target.value })} placeholder="Name, alias, or raw text" type="search" value={route.query}/></div></div>
        <button aria-controls="reference-filter-options" aria-expanded={filtersOpen} className="mobile-filter-toggle" onClick={() => setFiltersOpen((value) => !value)} type="button"><span>{filtersOpen ? 'Hide filters' : 'Filters'}</span><Badge>{route.kinds.length + route.categories.length + route.sources.length + (route.ppMin === undefined ? 0 : 1) + (route.ppMax === undefined ? 0 : 1)} active</Badge></button>
        <div className={`reference-filter-options${filtersOpen ? ' is-open' : ''}`} id="reference-filter-options">
        <div className="facet-group"><h3>Definition type</h3><div className="filter-chips" style={{ flexWrap: 'wrap' }}><button aria-pressed={route.kinds.length === 0} className="filter-chip" onClick={() => updateFilter({ kinds: [] }, 'push')} type="button">All</button>{kindOptions.map((option) => <button aria-pressed={route.kinds.includes(option.value as typeof route.kinds[number])} className="filter-chip" key={option.value} onClick={() => updateFilter({ kinds: toggleValue(route.kinds, option.value) as typeof route.kinds }, 'push')} type="button">{option.value === 'monsterMagic' ? 'Monster Magic' : option.value} ({option.count})</button>)}</div></div>
        {categoryOptions.length > 0 && <div className="facet-group"><h3>Category</h3><BoundedFacetOptions groupLabel="Reference category filters" onClear={() => updateFilter({ categories: [] }, 'push')} onToggle={(value) => updateFilter({ categories: toggleValue(route.categories, value) }, 'push')} options={categoryOptions} searchLabel="Search reference categories" selected={route.categories}/></div>}
        <div className="facet-group"><h3>Source</h3><BoundedFacetOptions formatOption={sourceDisplay} groupLabel="Reference source filters" onClear={() => updateFilter({ sources: [] }, 'push')} onToggle={(value) => updateFilter({ sources: toggleValue(route.sources, value) }, 'push')} options={sourceOptions} searchLabel="Search reference sources" selected={route.sources}/></div>
        <div className="facet-group"><h3>PP cost</h3><div className="grid-2"><label className="field"><span className="field__label">Minimum</span><input inputMode="numeric" onChange={(event) => updateFilter({ ppMin: numericInput(event.target.value) })} type="number" value={route.ppMin ?? ''}/></label><label className="field"><span className="field__label">Maximum</span><input inputMode="numeric" onChange={(event) => updateFilter({ ppMax: numericInput(event.target.value) })} type="number" value={route.ppMax ?? ''}/></label></div><small>PP bounds apply only where PP is meaningful. Unknown or conflicting costs remain possible matches.</small></div>
        <div className="facet-group"><h3>Catalog knowledge in matches</h3><div className="filter-chips" style={{ flexWrap: 'wrap' }}><Badge tone="positive">{knowledgeCounts.known} known</Badge><Badge tone="warning">{knowledgeCounts.unknown} unknown</Badge><Badge tone="danger">{knowledgeCounts.conflicting} conflicts</Badge></div></div>
        <div className="facet-group"><h3>Reference packs</h3>{catalogs.map((catalog) => <div className="source-claim" key={JSON.stringify([catalog.id, catalog.revisionId])}><span className="source-claim__line"/><div><strong>{catalog.id}</strong><p>Revision {catalog.revisionId}</p><small>{catalog.schemaVersion} · {Object.keys(catalog.entities).length} definitions</small></div></div>)}</div>
        {personalOptions.length > 0 && <div className="facet-group"><h3>Personal definitions</h3><p className="settings-section__intro">{preferredPersonalOptions.length} preferred immutable {preferredPersonalOptions.length === 1 ? 'lineage' : 'lineages'} plus {personalOptions.length - preferredPersonalOptions.length} historical revisions. Filters and results keep exact identities visible.</p></div>}
        </div>
      </aside>
      <section className="panel">
        {selectedPersonal ? <PersonalDetail onBack={() => navigation.close()} onEdit={() => navigation.navigate(routeWithOverlay(navigation.route, { kind: 'definition-editor', mode: 'override', ref: preferredDefinitionRef(profile, selectedPersonal.ref) }))} option={selectedPersonal}/> : selected ? <DetailView item={selected} onBack={() => navigation.close()} onEdit={() => navigation.navigate(routeWithOverlay(navigation.route, { kind: 'definition-editor', mode: 'override', ref: preferredDefinitionRef(profile, { kind: 'catalog', catalogId: selected.catalog.id, catalogRevisionId: selected.catalog.revisionId, entityId: selected.entity.id }) }))}/> : results.length || personalResults.length ? <div>
          {partition.confirmed.length + personalPartition.confirmed.length === 0 && partition.possible.length + personalPartition.possible.length > 0 && <div className="panel__body"><InlineNotice title="Only possible matches">Unknown or conflicting fields may satisfy the active filters. Review each source before relying on it.</InlineNotice></div>}
          {visiblePersonalResults.map((option) => { const possible = personalPartition.possible.includes(option); return <button className="reference-card" key={option.key} onClick={() => openDetail(option.ref)} style={{ width: '100%', color: 'inherit', background: 'none', borderInline: 0, borderTop: 0, textAlign: 'left' }} type="button"><div className="reference-card__meta"><Badge tone="info">{option.kind}</Badge><Badge>Personal</Badge>{option.modAvailability?.requiredMod && <Badge>{modAvailabilityLabel(option.modAvailability)}</Badge>}{possible && <Badge tone="warning">Possible match</Badge>}<Badge tone={option.preferred ? 'positive' : 'warning'}>{option.preferred ? 'Preferred revision' : 'Historical revision'}</Badge>{option.ppCost?.state === 'known' && <Badge tone="info">{option.ppCost.value} PP</Badge>}</div><h3>{option.name}</h3><p>{option.description ?? `${option.sourceLabel} · ${option.stockLabel}`}</p></button> })}
          {visibleCatalogResults.map((item) => { const possible = partition.possible.includes(item); const availability = optionsByKey.get(referenceDefinitionKey(item))?.modAvailability; const ref: EntityRef = { kind: 'catalog', catalogId: item.catalog.id, catalogRevisionId: item.catalog.revisionId, entityId: item.entity.id }; return <button className="reference-card" key={item.key} onClick={() => openDetail(ref)} style={{ width: '100%', color: 'inherit', background: 'none', borderInline: 0, borderTop: 0, textAlign: 'left' }} type="button"><div className="reference-card__meta"><Badge tone="info">{item.entity.kind}</Badge><Badge>{item.catalog.id}</Badge>{availability?.requiredMod && <Badge>{modAvailabilityLabel(availability)}</Badge>}{possible && <Badge tone="warning">Possible match</Badge>}{item.knowledgeCounts.conflicting > 0 && <Badge tone="danger">Source conflict</Badge>}{(item.entity.kind === 'passive' || item.entity.kind === 'innate') && <Badge tone={item.ppCost.state === 'known' ? 'info' : item.ppCost.state === 'conflicting' ? 'danger' : 'warning'}>{ppLabel(item)}</Badge>}</div><h3>{item.entity.name}</h3><p>{item.entity.rawDescription ?? `${Object.keys(item.entity.fields).length} normalized fields · ${item.claims.length} source claims`}</p></button> })}
          {totalResults > route.resultLimit && route.resultLimit < ROUTE_MAX_RESULT_LIMIT && <div className="panel__body"><Button onClick={() => updateRoute({ resultLimit: Math.min(ROUTE_MAX_RESULT_LIMIT, route.resultLimit + REFERENCE_PAGE_SIZE) }, 'replace')} tone="secondary">Show {Math.min(REFERENCE_PAGE_SIZE, totalResults - route.resultLimit)} more</Button></div>}
          {totalResults > ROUTE_MAX_RESULT_LIMIT && route.resultLimit >= ROUTE_MAX_RESULT_LIMIT && <div className="panel__body"><InlineNotice title="Result display limit reached">Refine the name, category, source, type, or PP filters to reach entries beyond the first {ROUTE_MAX_RESULT_LIMIT.toLocaleString()} matches.</InlineNotice></div>}
        </div> : <div className="panel__body"><InlineNotice title="No matches">Unknown fields are kept as possible only when they could satisfy every active filter. Try another name, category, source, kind, or PP bound.</InlineNotice></div>}
      </section>
    </div>}
    {missingEditingRef && <InlineNotice title="Definition override unavailable" tone="warning">The exact definition selected for this override is unavailable. Close this editor address and choose an available definition without changing the original reference. <Button onClick={() => navigation.close()} tone="quiet">Close editor</Button></InlineNotice>}
    {editingRef && editingOption && <DefinitionEditor allowedKinds={[]} baseRef={editingRef} key={entityDefinitionKey(editingRef)} onClose={() => navigation.close()} onSaved={(ref) => navigation.navigate({ ...navigation.route, page: { page: 'reference', view: 'detail', ref }, overlays: [] }, { replace: true })} open routeIndex={0}/>}
    <Sheet description="Collect reviewed preferred personal definitions into a new immutable ruleset revision. Existing build checkpoints keep their exact references, and the active ruleset does not change." onClose={() => navigation.close()} open={promoting} title="Collect into ruleset revision" width="wide"><div className="stack">
      <InlineNotice title="Promotion-ready collection">This creates a new ruleset revision from the selected source. It does not publish a catalog, rewrite old records, or activate the new revision.</InlineNotice>
      <div className="grid-2"><label className="field"><span className="field__label">Source ruleset revision</span><select onChange={(event) => setPromotionRulesetId(event.target.value as RulesetRevisionId)} value={promotionRulesetId}><option value="">Choose ruleset revision</option>{rulesets.map((ruleset) => <option key={ruleset.id} value={ruleset.id}>{ruleset.label} · revision {ruleset.revision}</option>)}</select></label><label className="field"><span className="field__label">New revision label</span><input onChange={(event) => setPromotionLabel(event.target.value)} required value={promotionLabel}/></label></div>
      <fieldset className="definition-collection"><legend>Preferred personal definitions</legend>{preferredPersonalOptions.map((option) => { const checked = promotionRefs.some((ref) => entityDefinitionKey(ref) === option.key); return <label className="check-row" key={option.key}><input checked={checked} onChange={(event) => setPromotionRefs((current) => event.target.checked ? [...current, option.ref] : current.filter((ref) => entityDefinitionKey(ref) !== option.key))} type="checkbox"/><span><strong>{option.name}</strong><small>{option.kind} · {option.sourceLabel}</small></span></label> })}</fieldset>
      {promotionError && <InlineNotice title="Ruleset revision not created" tone="danger">{promotionError} Your selected definitions remain checked.</InlineNotice>}
      <div className="form-actions"><Button disabled={promotionBusy} onClick={() => navigation.close()} tone="quiet">Cancel</Button><Button disabled={promotionBusy || !promotionRulesetId || !promotionRefs.length || !promotionLabel.trim()} icon="check" onClick={() => void promote()}>{promotionBusy ? 'Creating revision...' : 'Create ruleset revision'}</Button></div>
    </div></Sheet>
  </>
}
