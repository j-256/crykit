import { forwardRef, useId, useMemo, useRef, useState, type ButtonHTMLAttributes, type PropsWithChildren, type ReactNode, type RefObject } from 'react'
import { Dropdown } from './Dropdown'
import { Icon, type IconName } from './icons'

export function Button({ children, className = '', tone = 'primary', icon, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'primary' | 'secondary' | 'quiet' | 'danger'; icon?: IconName }) {
  return <button className={`button button--${tone} ${className}`} {...props}>{icon && <Icon name={icon} />}{children}</button>
}

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; icon: IconName }>(function IconButton({ label, icon, className = '', ...props }, ref) {
  return <button aria-label={label} className={`icon-button ${className}`} ref={ref} title={label} type="button" {...props}><Icon name={icon} /></button>
})

export function Badge({ children, tone = 'neutral', icon }: PropsWithChildren<{ tone?: 'positive' | 'warning' | 'danger' | 'info' | 'neutral'; icon?: IconName }>) {
  return <span className={`badge badge--${tone}`}>{icon && <Icon name={icon} />}{children}</span>
}

export function ScreenHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description: string; actions?: ReactNode }) {
  return <header className="screen-header"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="screen-header__description">{description}</p></div>{actions && <div className="screen-header__actions">{actions}</div>}</header>
}

export function EmptyState({ icon, title, description, children, aside, className = '' }: PropsWithChildren<{ icon: IconName; title: string; description: string; aside?: ReactNode; className?: string }>) {
  return <section className={`empty-state ${className}`}><div className="empty-state__mark"><Icon name={icon} /></div><div className="empty-state__copy"><h2>{title}</h2><p>{description}</p><div className="empty-state__actions">{children}</div></div>{aside && <div className="empty-state__aside">{aside}</div>}</section>
}

export function Field({ label, hint, required, children, className = '' }: PropsWithChildren<{ label: string; hint?: string; required?: boolean; className?: string }>) {
  return <label className={`field ${className}`}><span className="field__label">{label}{required && <span aria-hidden="true"> *</span>}</span>{children}{hint && <span className="field__hint">{hint}</span>}</label>
}

export function InlineNotice({ title, children, tone = 'info' }: PropsWithChildren<{ title: string; tone?: 'info' | 'warning' | 'danger' | 'positive' }>) {
  const icon = tone === 'positive' ? 'check' : tone === 'info' ? 'info' : 'warning'
  return <div className={`notice notice--${tone}`} role={tone === 'danger' ? 'alert' : 'status'}><Icon name={icon}/><div><strong>{title}</strong><div className="notice__body">{children}</div></div></div>
}

export function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly { value: T; label: string }[]; onChange: (value: T) => void }) {
  return <div aria-label={label} className="segmented" role="group">{options.map((option) => <button aria-pressed={value === option.value} key={option.value} onClick={() => onChange(option.value)} type="button">{option.label}</button>)}</div>
}

export const FACET_OPTION_DOM_LIMIT = 40

export interface FacetOptionDisplay {
  readonly label: string
  readonly detail?: string
}

export function BoundedFacetOptions({ groupLabel, searchLabel, options, selected, onClear, onToggle, formatOption, alwaysSearch = false, searchInputRef }: { groupLabel: string; searchLabel: string; options: readonly { value: string; count: number }[]; selected: readonly string[]; onClear: () => void; onToggle: (value: string) => void; formatOption?: (value: string) => FacetOptionDisplay; alwaysSearch?: boolean; searchInputRef?: RefObject<HTMLInputElement | null> }) {
  const [query, setQuery] = useState('')
  const searchable = alwaysSearch || options.length > FACET_OPTION_DOM_LIMIT
  const filtered = useMemo(() => {
    const normalized = searchable ? query.trim().toLocaleLowerCase() : ''
    return normalized ? options.filter((option) => {
      const display = formatOption?.(option.value)
      return [option.value, display?.label, display?.detail].some((value) => value?.toLocaleLowerCase().includes(normalized))
    }) : options
  }, [formatOption, options, query, searchable])
  const visible = filtered.slice(0, FACET_OPTION_DOM_LIMIT)
  const omitted = filtered.length - visible.length
  return <div className="bounded-facet-options">
    {searchable && <div className="search-field bounded-facet-options__search"><Icon name="search"/><input aria-label={searchLabel} onChange={(event) => setQuery(event.target.value)} placeholder="Search this facet" ref={searchInputRef} type="search" value={query}/></div>}
    <div aria-label={groupLabel} className="filter-chips" role="group"><button aria-pressed={selected.length === 0} className="filter-chip" onClick={onClear} type="button"><span className="filter-chip__label">All</span></button>{visible.map((option) => {
      const display = formatOption?.(option.value) ?? { label: option.value }
      const accessibleLabel = formatOption ? `${display.label}. Full source: ${option.value}. ${option.count} matches` : `${option.value} (${option.count})`
      return <button aria-label={accessibleLabel} aria-pressed={selected.includes(option.value)} className="filter-chip" key={option.value} onClick={() => onToggle(option.value)} title={formatOption ? option.value : undefined} type="button"><span className="filter-chip__copy"><span className="filter-chip__label">{display.label}</span>{display.detail && <span className="filter-chip__detail">{display.detail}</span>}</span><span aria-hidden="true" className="filter-chip__count">{option.count}</span></button>
    })}</div>
    {omitted > 0 && <small className="bounded-facet-options__summary" role="status">Showing the first {visible.length} of {filtered.length} options. Search this facet to reach the remaining {omitted}.</small>}
    {searchable && filtered.length === 0 && <small className="bounded-facet-options__summary" role="status">No facet options match this search.</small>}
  </div>
}

export function FacetDropdown({ label, allLabel, groupLabel, searchLabel, options, selected, onClear, onToggle, formatOption }: { label: string; allLabel: string; groupLabel: string; searchLabel: string; options: readonly { value: string; count: number }[]; selected: readonly string[]; onClear: () => void; onToggle: (value: string) => void; formatOption?: (value: string) => FacetOptionDisplay }) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const dropdownId = useId()
  const selectedOptions = options.filter((option) => selected.includes(option.value))
  const summary = selectedOptions.length === 0 ? allLabel : selectedOptions.length === 1 ? (formatOption?.(selectedOptions[0]!.value).label ?? selectedOptions[0]!.value) : `${selectedOptions.length} selected`
  const close = () => setOpen(false)
  return <div className="facet-dropdown-field">
    <h3>{label}</h3>
    <button aria-controls={open ? dropdownId : undefined} aria-expanded={open} aria-haspopup="dialog" aria-label={`${label}: ${summary}`} className="facet-dropdown-trigger" onClick={() => setOpen((value) => !value)} onKeyDown={(event) => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true) } }} ref={anchorRef} type="button"><span><strong>{summary}</strong><small>{options.length} {options.length === 1 ? 'option' : 'options'}</small></span><Icon name="chevron-down"/></button>
    <Dropdown anchorRef={anchorRef} id={dropdownId} initialFocusRef={searchRef} onClose={close} onDismiss={close} open={open} title={`Filter by ${label.toLocaleLowerCase()}`}>
      <div className="facet-dropdown__content"><BoundedFacetOptions alwaysSearch formatOption={formatOption} groupLabel={groupLabel} onClear={onClear} onToggle={onToggle} options={options} searchInputRef={searchRef} searchLabel={searchLabel} selected={selected}/></div>
    </Dropdown>
  </div>
}

export function DefinitionRow({ term, children }: PropsWithChildren<{ term: string }>) {
  return <div className="definition-row"><dt>{term}</dt><dd>{children}</dd></div>
}

export function ProgressRing({ value, label }: { value: number; label: string }) {
  return <div aria-label={`${label}: ${value}%`} className="progress-ring" role="img" style={{ '--progress': `${Math.max(0, Math.min(value, 100)) * 3.6}deg` } as React.CSSProperties}><span>{value}%</span></div>
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <span className="spinner" role="status"><span className="sr-only">{label}</span></span>
}
