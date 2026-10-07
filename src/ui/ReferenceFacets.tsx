import { useId, useMemo, useState, type PropsWithChildren } from 'react'
import { FACET_OPTION_DOM_LIMIT } from './components'
import { Icon } from './icons'
import { CATEGORY_GROUPS, type CategoryGroup } from './reference-facets'
import { referenceCategoryLabel, referenceCategorySearchText } from './reference-categories'
import type { FacetOption } from './search'

export function ReferenceFacetSection({ title, active = 0, summary = 'Any', selection, children }: PropsWithChildren<{ title: string; active?: number; summary?: string; selection?: readonly string[] }>) {
  const [open, setOpen] = useState(active > 0)
  const id = useId()
  return <section className="facet-group reference-facet-section">
    <h3><button aria-controls={id} aria-expanded={open} aria-label={title} className="reference-facet-section__toggle" onClick={() => setOpen(value => !value)} type="button"><span>{title}<small>{selection?.length ? selection.join(' or ') : active ? `${active} selected` : summary}</small></span><Icon name="chevron-down"/></button></h3>
    <div className="reference-facet-section__body" hidden={!open} id={id}>{open ? children : null}</div>
  </section>
}

export function ReferenceCategoryFilters({ options, groups, selected, onClear, onToggle }: { options: readonly FacetOption[]; groups: ReadonlyMap<string, CategoryGroup>; selected: readonly string[]; onClear: () => void; onToggle: (value: string) => void }) {
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<CategoryGroup>()
  const id = useId()
  const normalized = query.trim().toLocaleLowerCase()
  const matching = useMemo(() => options.filter(option => !normalized || [referenceCategorySearchText(option.value), groups.get(option.value)].some(value => value?.toLocaleLowerCase().includes(normalized))), [groups, normalized, options])
  const visible = normalized ? matching.slice(0, FACET_OPTION_DOM_LIMIT) : matching.filter(option => groups.get(option.value) === expanded).slice(0, FACET_OPTION_DOM_LIMIT)
  const total = normalized ? matching.length : matching.filter(option => groups.get(option.value) === expanded).length
  return <div className="reference-category-filters">
    <div className="search-field"><Icon name="search"/><input aria-label="Search reference categories" onChange={event => setQuery(event.target.value)} placeholder="Find any category" type="search" value={query}/></div>
    {selected.length > 0 && <p className="reference-category-selection">{selected.map(referenceCategoryLabel).join(' or ')}</p>}
    <div aria-label="Reference category filters" className="reference-category-groups" role="group">
      <button aria-pressed={selected.length === 0} className="filter-chip" onClick={onClear} type="button">All categories</button>
      {CATEGORY_GROUPS.map((group, index) => {
        const all = matching.filter(option => groups.get(option.value) === group)
        if (!all.length) return null
        const entries = visible.filter(option => groups.get(option.value) === group)
        const active = all.filter(option => selected.includes(option.value)).length
        const open = Boolean(normalized) || expanded === group
        return <div className="reference-category-group" key={group}>
          {normalized ? entries.length > 0 && <h4>{group}</h4> : <button aria-controls={`${id}-${index}`} aria-expanded={open} className="reference-category-group__toggle" onClick={() => setExpanded(open ? undefined : group)} type="button"><Icon name="chevron-down"/><span>{group}</span><small>{active ? `${active} selected` : all.length}</small></button>}
          <div hidden={!open || !entries.length} id={`${id}-${index}`}>{open && entries.length > 0 && <div className="bounded-facet-options"><div className="filter-chips">{entries.map(option => <button aria-label={`${referenceCategoryLabel(option.value)} (${option.count})`} aria-pressed={selected.includes(option.value)} className="filter-chip" key={option.value} onClick={() => onToggle(option.value)} type="button"><span className="filter-chip__label">{referenceCategoryLabel(option.value)}</span><span aria-hidden="true" className="filter-chip__count">{option.count}</span></button>)}</div></div>}</div>
        </div>
      })}
    </div>
    {total > visible.length && <small className="bounded-facet-options__summary" role="status">Showing {visible.length} of {total} categories. Search to reach every category.</small>}
    {normalized && !matching.length && <small className="bounded-facet-options__summary" role="status">No categories match this search.</small>}
  </div>
}
