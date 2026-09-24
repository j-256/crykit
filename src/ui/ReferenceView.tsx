import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CatalogClaim, CatalogSnapshot, JsonValue, Knowledge, Profile, SourceRef } from '../domain/types'
import { Badge, BoundedFacetOptions, Button, EmptyState, InlineNotice, ScreenHeader } from './components'
import { Icon } from './icons'
import { knowledgeTone } from './model'
import {
  aggregateKnowledgeCounts,
  buildFacetOptions,
  buildReferenceSearchItems,
  partitionReferenceItems,
  type ReferenceSearchItem,
} from './search'
import {
  commitReferenceRouteState,
  readReferenceRouteState,
  REFERENCE_PAGE_SIZE,
  ROUTE_MAX_RESULT_LIMIT,
  type ReferenceRouteState,
} from './route-state'

function knowledgeValue(value: Knowledge<unknown>): string {
  if (value.state === 'known') return typeof value.value === 'string' ? value.value : JSON.stringify(value.value)
  if (value.state === 'conflicting') return `${value.claims.length} conflicting claims`
  if (value.state === 'notApplicable') return 'Not applicable'
  return value.reason ?? 'Unknown'
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
  return <><strong>{source.sourceId}</strong><p>{source.locator ?? 'No source locator supplied'}</p><small>{source.applicability ?? 'Applicability not stated'}{href ? <> · <a href={href} rel="noreferrer noopener" target="_blank">Open source</a></> : null}</small></>
}

function ClaimValue({ value }: { value: Knowledge<JsonValue> }) {
  if (value.state !== 'conflicting') return <p>{knowledgeValue(value)}</p>
  return <div className="stack">{value.claims.map((claim, index) => <div key={index}><p>{typeof claim.value === 'string' ? claim.value : JSON.stringify(claim.value)}</p><small>{claim.note ?? 'Conflicting source value'}{claim.sources.length ? ` · ${claim.sources.map((source) => source.sourceId).join(' · ')}` : ''}</small></div>)}</div>
}

function ClaimTrail({ claim }: { claim: CatalogClaim }) {
  return <div className="source-claim"><span className="source-claim__line"/><div><strong>{claim.field}</strong><ClaimValue value={claim.value}/><small>{claim.sources.length ? claim.sources.map((source) => { const href = sourceHref(source); return href ? <span key={`${source.sourceId}:${source.locator ?? ''}`}><a href={href} rel="noreferrer noopener" target="_blank">{source.sourceId}</a>{source.locator && source.locator !== href ? `: ${source.locator}` : ''} </span> : <span key={`${source.sourceId}:${source.locator ?? ''}`}>{source.sourceId}{source.locator ? `: ${source.locator}` : ''} </span> }) : 'No source locator supplied'}</small></div></div>
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

function DetailView({ item, onBack }: { item: ReferenceSearchItem; onBack: () => void }) {
  return <div className="panel__body stack">
    <Button icon="arrow-left" onClick={onBack} tone="quiet">Back to results</Button>
    <div><div className="reference-card__meta"><Badge tone="info">{item.entity.kind}</Badge><Badge>{item.catalog.id}</Badge><Badge tone={knowledgeTone(item.catalog.applicability)}>{item.catalog.applicability.state === 'known' ? item.catalog.applicability.value : 'Applicability unknown'}</Badge>{item.knowledgeCounts.conflicting > 0 && <Badge tone="danger">{item.knowledgeCounts.conflicting} conflicts</Badge>}</div><h2>{item.entity.name}</h2><p>{item.entity.rawDescription ?? 'No raw description supplied.'}</p>{item.entity.aliases.length > 0 && <small>Aliases: {item.entity.aliases.join(', ')}</small>}</div>
    <div className="grid-2">
      <div className="panel"><div className="panel__header"><h3>Normalized fields</h3></div><div className="panel__body">{Object.keys(item.entity.fields).length ? <dl className="definition-list">{Object.entries(item.entity.fields).map(([field, value]) => <div className="definition-row" key={field}><dt>{field}</dt><dd>{knowledgeValue(value)} <Badge tone={knowledgeTone(value)}>{value.state}</Badge></dd></div>)}</dl> : <InlineNotice title="No normalized fields">Identity and source claims may still contain useful source details.</InlineNotice>}</div></div>
      <div className="panel"><div className="panel__header"><h3>Source trail</h3></div><div className="panel__body">{item.entity.sources.length ? item.entity.sources.map((source, index) => <div className="source-claim" key={`${source.sourceId}:${source.locator ?? ''}:${index}`}><span className="source-claim__line"/><div><SourceSummary source={source}/></div></div>) : <InlineNotice title="No entity sources">Inspect the catalog pack provenance before relying on this definition.</InlineNotice>}</div></div>
    </div>
    <div className="panel"><div className="panel__header"><div><h3>Imported claims</h3><p>Original auxiliary stats, locations, growth data, and unresolved source values</p></div></div><div className="panel__body">{item.claims.length ? item.claims.map((claim, index) => <ClaimTrail claim={claim} key={`${claim.field}:${index}`}/>) : <InlineNotice title="No separate claims">This definition did not include auxiliary or conflicting source claims.</InlineNotice>}</div></div>
  </div>
}

export function ReferenceView({ profile, catalogs, onOpenData }: { profile: Profile; catalogs: readonly CatalogSnapshot[]; onOpenData: () => void }) {
  const [route, setRoute] = useState<ReferenceRouteState>(() => readReferenceRouteState())
  const [filtersOpen, setFiltersOpen] = useState(false)
  const items = useMemo(() => buildReferenceSearchItems(catalogs), [catalogs])
  const kindOptions = useMemo(() => buildFacetOptions(items, 'kind'), [items])
  const categoryOptions = useMemo(() => buildFacetOptions(items, 'category'), [items])
  const sourceOptions = useMemo(() => buildFacetOptions(items, 'source'), [items])
  const partition = useMemo(() => partitionReferenceItems(items, {
    query: route.query,
    kinds: route.kinds,
    categories: route.categories,
    sources: route.sources,
    ...(route.ppMin === undefined && route.ppMax === undefined ? {} : { pp: { min: route.ppMin, max: route.ppMax, unit: 'PP' } }),
  }), [items, route.categories, route.kinds, route.ppMax, route.ppMin, route.query, route.sources])
  const results = useMemo(() => [...partition.confirmed, ...partition.possible], [partition.confirmed, partition.possible])
  const selected = route.selectedKey ? items.find((item) => item.key === route.selectedKey) : undefined
  const knowledgeCounts = useMemo(() => aggregateKnowledgeCounts(results), [results])
  const personalDefinitions = Object.values(profile.personalDefinitions)

  useEffect(() => {
    commitReferenceRouteState(route, 'replace')
    const restore = () => setRoute(readReferenceRouteState())
    window.addEventListener('popstate', restore)
    window.addEventListener('hashchange', restore)
    return () => {
      window.removeEventListener('popstate', restore)
      window.removeEventListener('hashchange', restore)
    }
  }, [])

  const updateRoute = useCallback((change: Partial<ReferenceRouteState>, mode: 'push' | 'replace' = 'replace') => {
    setRoute((current) => commitReferenceRouteState({ ...current, ...change }, mode))
  }, [])

  useEffect(() => {
    if (route.selectedKey && !selected) updateRoute({ selectedKey: undefined }, 'replace')
  }, [route.selectedKey, selected, updateRoute])

  const updateFilter = useCallback((change: Partial<ReferenceRouteState>, mode: 'push' | 'replace' = 'replace') => {
    updateRoute({ ...change, selectedKey: undefined, resultLimit: REFERENCE_PAGE_SIZE }, mode)
  }, [updateRoute])

  return <>
    <ScreenHeader actions={<Button icon="upload" onClick={onOpenData} tone="secondary">Import reference</Button>} description="Inspect definitions, source claims, applicability, and unresolved conflicts without changing personal records." eyebrow="Field reference" title="Reference"/>
    {catalogs.length === 0 ? <EmptyState aside={<>Reference packs are optional. You can track personal items, characters, and progress without one, then link entries after importing a pack.</>} description="No catalog is bundled with the app. Import a permitted reference pack locally and review its format, rights, and coverage before adding it." icon="book" title="Reference library is empty"><Button icon="upload" onClick={onOpenData}>Import a reference pack</Button></EmptyState> : <div className="reference-layout">
      <aside className="panel facet-panel">
        <div className="panel__header"><div><h2>Refine</h2><p>{partition.confirmed.length} confirmed · {partition.possible.length} possible</p></div></div>
        <div className="facet-group"><div className="search-field"><Icon name="search"/><input aria-label="Search reference" onChange={(event) => updateFilter({ query: event.target.value })} placeholder="Name, alias, or raw text" type="search" value={route.query}/></div></div>
        <button aria-controls="reference-filter-options" aria-expanded={filtersOpen} className="mobile-filter-toggle" onClick={() => setFiltersOpen((value) => !value)} type="button"><span>{filtersOpen ? 'Hide filters' : 'Filters'}</span><Badge>{route.kinds.length + route.categories.length + route.sources.length + (route.ppMin === undefined ? 0 : 1) + (route.ppMax === undefined ? 0 : 1)} active</Badge></button>
        <div className={`reference-filter-options${filtersOpen ? ' is-open' : ''}`} id="reference-filter-options">
        <div className="facet-group"><h3>Definition type</h3><div className="filter-chips" style={{ flexWrap: 'wrap' }}><button aria-pressed={route.kinds.length === 0} className="filter-chip" onClick={() => updateFilter({ kinds: [] }, 'push')} type="button">All</button>{kindOptions.map((option) => <button aria-pressed={route.kinds.includes(option.value as typeof route.kinds[number])} className="filter-chip" key={option.value} onClick={() => updateFilter({ kinds: toggleValue(route.kinds, option.value) as typeof route.kinds }, 'push')} type="button">{option.value === 'monsterMagic' ? 'Monster Magic' : option.value} ({option.count})</button>)}</div></div>
        {categoryOptions.length > 0 && <div className="facet-group"><h3>Category</h3><BoundedFacetOptions groupLabel="Reference category filters" onClear={() => updateFilter({ categories: [] }, 'push')} onToggle={(value) => updateFilter({ categories: toggleValue(route.categories, value) }, 'push')} options={categoryOptions} searchLabel="Search reference categories" selected={route.categories}/></div>}
        <div className="facet-group"><h3>Source</h3><BoundedFacetOptions groupLabel="Reference source filters" onClear={() => updateFilter({ sources: [] }, 'push')} onToggle={(value) => updateFilter({ sources: toggleValue(route.sources, value) }, 'push')} options={sourceOptions} searchLabel="Search reference sources" selected={route.sources}/></div>
        <div className="facet-group"><h3>PP cost</h3><div className="grid-2"><label className="field"><span className="field__label">Minimum</span><input inputMode="numeric" onChange={(event) => updateFilter({ ppMin: numericInput(event.target.value) })} type="number" value={route.ppMin ?? ''}/></label><label className="field"><span className="field__label">Maximum</span><input inputMode="numeric" onChange={(event) => updateFilter({ ppMax: numericInput(event.target.value) })} type="number" value={route.ppMax ?? ''}/></label></div><small>PP bounds apply only where PP is meaningful. Unknown or conflicting costs remain possible matches.</small></div>
        <div className="facet-group"><h3>Knowledge in matches</h3><div className="filter-chips" style={{ flexWrap: 'wrap' }}><Badge tone="positive">{knowledgeCounts.known} known</Badge><Badge tone="warning">{knowledgeCounts.unknown} unknown</Badge><Badge tone="danger">{knowledgeCounts.conflicting} conflicts</Badge></div></div>
        <div className="facet-group"><h3>Imported packs</h3>{catalogs.map((catalog) => <div className="source-claim" key={JSON.stringify([catalog.id, catalog.revisionId])}><span className="source-claim__line"/><div><strong>{catalog.id}</strong><p>Revision {catalog.revisionId}</p><small>{catalog.schemaVersion} · {Object.keys(catalog.entities).length} definitions</small></div></div>)}</div>
        {personalDefinitions.length > 0 && <div className="facet-group"><h3>Personal definitions</h3><p className="settings-section__intro">{personalDefinitions.length} unmatched {personalDefinitions.length === 1 ? 'entry' : 'entries'} remain separate from imported packs.</p></div>}
        </div>
      </aside>
      <section className="panel">
        {selected ? <DetailView item={selected} onBack={() => updateRoute({ selectedKey: undefined }, 'push')}/> : results.length ? <div>
          {partition.confirmed.length === 0 && partition.possible.length > 0 && <div className="panel__body"><InlineNotice title="Only possible matches">Unknown or conflicting fields may satisfy the active filters. Review each source before relying on it.</InlineNotice></div>}
          {results.slice(0, route.resultLimit).map((item) => { const possible = partition.possible.includes(item); return <button className="reference-card" key={item.key} onClick={() => updateRoute({ selectedKey: item.key }, 'push')} style={{ width: '100%', color: 'inherit', background: 'none', borderInline: 0, borderTop: 0, textAlign: 'left' }} type="button"><div className="reference-card__meta"><Badge tone="info">{item.entity.kind}</Badge><Badge>{item.catalog.id}</Badge>{possible && <Badge tone="warning">Possible match</Badge>}{item.knowledgeCounts.conflicting > 0 && <Badge tone="danger">Source conflict</Badge>}{(item.entity.kind === 'passive' || item.entity.kind === 'innate') && <Badge tone={item.ppCost.state === 'known' ? 'info' : item.ppCost.state === 'conflicting' ? 'danger' : 'warning'}>{ppLabel(item)}</Badge>}</div><h3>{item.entity.name}</h3><p>{item.entity.rawDescription ?? `${Object.keys(item.entity.fields).length} normalized fields · ${item.claims.length} source claims`}</p></button> })}
          {results.length > route.resultLimit && route.resultLimit < ROUTE_MAX_RESULT_LIMIT && <div className="panel__body"><Button onClick={() => updateRoute({ resultLimit: Math.min(ROUTE_MAX_RESULT_LIMIT, route.resultLimit + REFERENCE_PAGE_SIZE) }, 'replace')} tone="secondary">Show {Math.min(REFERENCE_PAGE_SIZE, results.length - route.resultLimit)} more</Button></div>}
          {results.length > ROUTE_MAX_RESULT_LIMIT && route.resultLimit >= ROUTE_MAX_RESULT_LIMIT && <div className="panel__body"><InlineNotice title="Result display limit reached">Refine the name, category, source, type, or PP filters to reach entries beyond the first {ROUTE_MAX_RESULT_LIMIT.toLocaleString()} matches.</InlineNotice></div>}
        </div> : <div className="panel__body"><InlineNotice title="No matches">Unknown fields are kept as possible only when they could satisfy every active filter. Try another name, category, source, kind, or PP bound.</InlineNotice></div>}
      </section>
    </div>}
  </>
}
