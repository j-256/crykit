import { forwardRef, useMemo, useState, type ButtonHTMLAttributes, type PropsWithChildren, type ReactNode } from 'react'
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

export function EmptyState({ icon, title, description, children, aside }: PropsWithChildren<{ icon: IconName; title: string; description: string; aside?: ReactNode }>) {
  return <section className="empty-state"><div className="empty-state__mark"><Icon name={icon} /></div><div className="empty-state__copy"><h2>{title}</h2><p>{description}</p><div className="empty-state__actions">{children}</div></div>{aside && <div className="empty-state__aside">{aside}</div>}</section>
}

export function Field({ label, hint, required, children, className = '' }: PropsWithChildren<{ label: string; hint?: string; required?: boolean; className?: string }>) {
  return <label className={`field ${className}`}><span className="field__label">{label}{required && <span aria-hidden="true"> *</span>}</span>{children}{hint && <span className="field__hint">{hint}</span>}</label>
}

export function InlineNotice({ title, children, tone = 'info' }: PropsWithChildren<{ title: string; tone?: 'info' | 'warning' | 'danger' | 'positive' }>) {
  const icon = tone === 'positive' ? 'check' : tone === 'info' ? 'info' : 'warning'
  return <div className={`notice notice--${tone}`} role={tone === 'danger' ? 'alert' : 'status'}><Icon name={icon}/><div><strong>{title}</strong><p>{children}</p></div></div>
}

export function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly { value: T; label: string }[]; onChange: (value: T) => void }) {
  return <div aria-label={label} className="segmented" role="group">{options.map((option) => <button aria-pressed={value === option.value} key={option.value} onClick={() => onChange(option.value)} type="button">{option.label}</button>)}</div>
}

const FACET_OPTION_DOM_LIMIT = 40

export function BoundedFacetOptions({ groupLabel, searchLabel, options, selected, onClear, onToggle }: { groupLabel: string; searchLabel: string; options: readonly { value: string; count: number }[]; selected: readonly string[]; onClear: () => void; onToggle: (value: string) => void }) {
  const [query, setQuery] = useState('')
  const searchable = options.length > FACET_OPTION_DOM_LIMIT
  const filtered = useMemo(() => {
    const normalized = searchable ? query.trim().toLocaleLowerCase() : ''
    return normalized ? options.filter((option) => option.value.toLocaleLowerCase().includes(normalized)) : options
  }, [options, query, searchable])
  const visible = filtered.slice(0, FACET_OPTION_DOM_LIMIT)
  const omitted = filtered.length - visible.length
  return <div className="bounded-facet-options">
    {searchable && <div className="search-field bounded-facet-options__search"><Icon name="search"/><input aria-label={searchLabel} onChange={(event) => setQuery(event.target.value)} placeholder="Search this facet" type="search" value={query}/></div>}
    <div aria-label={groupLabel} className="filter-chips" role="group"><button aria-pressed={selected.length === 0} className="filter-chip" onClick={onClear} type="button">All</button>{visible.map((option) => <button aria-pressed={selected.includes(option.value)} className="filter-chip" key={option.value} onClick={() => onToggle(option.value)} type="button">{option.value} ({option.count})</button>)}</div>
    {omitted > 0 && <small className="bounded-facet-options__summary" role="status">Showing the first {visible.length} of {filtered.length} options. Search this facet to reach the remaining {omitted}.</small>}
    {searchable && filtered.length === 0 && <small className="bounded-facet-options__summary" role="status">No facet options match this search.</small>}
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
