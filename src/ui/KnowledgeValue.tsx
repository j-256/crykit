import type { Knowledge, KnowledgeClaim, SourceRef } from '../domain/types'
import { sourceDisplay } from './source-display'
import { fieldIconKey } from '../catalog/menu-icons'
import { GameIcon } from './GameIcon'

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function StructuredValue({ value, field }: { value: unknown; field?: string }) {
  if (value === null) return <span>Null</span>
  if (typeof value === 'string') {
    const parts = value.split(/(,\s*)/)
    if (field && parts.some(part => fieldIconKey(field, part))) return <span className="icon-values">{parts.map((part, index) => /^,\s*$/.test(part) ? <span key={index}>{part}</span> : <span className="icon-label" key={index}><GameIcon iconKey={fieldIconKey(field, part)}/><span>{part}</span></span>)}</span>
    return <span className="structured-value__text">{value}</span>
  }
  if (typeof value === 'number' || typeof value === 'boolean') return <span>{String(value)}</span>
  if (Array.isArray(value)) {
    if (value.length === 0) return <span>None</span>
    if (value.every(isRecord)) {
      const columns = Array.from(new Set(value.flatMap((row) => Object.keys(row))))
      return <div className="structured-value__table"><table><thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{value.map((row, rowIndex) => <tr key={rowIndex}>{columns.map((column) => <td key={column}><StructuredValue field={column} value={row[column]}/></td>)}</tr>)}</tbody></table></div>
    }
    return <ul className="structured-value__list" role="list">{value.map((entry, index) => <li key={index}><StructuredValue field={field} value={entry}/></li>)}</ul>
  }
  if (isRecord(value)) return <dl className="structured-value__record">{Object.entries(value).map(([name, nested]) => <div key={name}><dt>{name}</dt><dd><StructuredValue field={name} value={nested}/></dd></div>)}</dl>
  return <span>{String(value)}</span>
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

export function SourceSummary({ source }: { source: SourceRef }) {
  const href = sourceHref(source)
  const display = sourceDisplay(source.sourceId)
  return <div className="source-summary"><strong>{href ? <a href={href} rel="noreferrer noopener" target="_blank">{display.label}</a> : display.label}</strong><p>{source.locator ?? source.sourceId}</p><small>{[source.snapshot, source.checkedAt ? `Checked ${source.checkedAt}` : undefined, display.detail, source.applicability ?? 'Applicability not stated'].filter(Boolean).join(' · ')}</small></div>
}

export function SourceReferences({ sources }: { sources: readonly SourceRef[] }) {
  return <div className="source-references">{sources.length ? sources.map((source, index) => <SourceSummary key={`${source.sourceId}:${source.locator ?? ''}:${index}`} source={source}/>) : <small>No source locator supplied</small>}</div>
}

interface ClaimSelection {
  readonly name: string
  readonly index?: number
  readonly onChange: (index: number) => void
}

export function ClaimList({ claims, selection, field }: { claims: readonly KnowledgeClaim<unknown>[]; selection?: ClaimSelection; field?: string }) {
  return <ol className="knowledge-claims">{claims.map((claim, index) => <li className="knowledge-claim" key={index}>
    {selection ? <label className="check-row"><input aria-describedby={`${selection.name}-claim-${index}`} checked={selection.index === index} name={selection.name} onChange={() => selection.onChange(index)} type="radio" value={index}/><strong>Use claim {index + 1}</strong></label> : <strong className="knowledge-claim__label">Claim {index + 1}</strong>}
    <div className="knowledge-claim__value" id={selection ? `${selection.name}-claim-${index}` : undefined}><StructuredValue field={field} value={claim.value}/></div>
    {claim.note && <p className="knowledge-claim__note">{claim.note}</p>}
    <SourceReferences sources={claim.sources}/>
  </li>)}</ol>
}

export function KnowledgeValue({ value, field, compact = false, showSources = false }: { value: Knowledge<unknown>; field?: string; compact?: boolean; showSources?: boolean }) {
  if (value.state === 'known') return <><StructuredValue field={field} value={value.value}/>{showSources && value.sources?.length ? <SourceReferences sources={value.sources}/> : null}</>
  if (value.state === 'conflicting') return <><span>{value.claims.length} differing source values</span>{!compact && <ClaimList claims={value.claims} field={field}/>}</>
  if (value.state === 'notApplicable') return <span>{value.reason ?? 'Not applicable'}</span>
  return <span>{value.reason ?? 'Unknown'}</span>
}
