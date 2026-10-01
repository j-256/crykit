import type { ReactNode } from 'react'
import type { CatalogClaim, CatalogEntity, Knowledge, PersonalDefinition, SourceRef } from '../domain/types'
import { Badge, InlineNotice } from './components'
import { KnowledgeValue, SourceReferences, SourceSummary } from './KnowledgeValue'
import { knowledgeTone } from './model'
import { definitionFactIsWide, definitionFactLabel, visibleSources } from './source-display'
import { StatLabel } from './StatRatings'
import { Icon } from './icons'
import { corroboratedFact, type CorroborationTarget } from '../catalog/source-corroboration'

export function DefinitionFactsPanel({ facts, primarySourceId, corroboration, renderValue, children }: { facts: readonly (readonly [string, Knowledge<unknown>])[]; primarySourceId?: string; corroboration?: CorroborationTarget; renderValue?: (field: string, value: Knowledge<unknown>, content: ReactNode) => ReactNode; children?: ReactNode }) {
  const fields = facts.map(([field]) => field)
  const orderedFacts = [...facts].sort(([left], [right]) => Number(/^cost$/i.test(left)) - Number(/^cost$/i.test(right)))
  return <section className="panel" aria-label="Definition facts"><div className="panel__header"><h3 className="icon-label"><Icon name="book"/>Definition facts</h3></div><div className="panel__body">{facts.length ? <dl className="definition-list definition-facts">{orderedFacts.map(([field, value]) => {
    const sources = value.state === 'known' && !corroboratedFact(corroboration, field, value) ? corroboration ? value.sources ?? [] : visibleSources(value.sources?.filter(source => source.sourceId !== primarySourceId) ?? []) : []
    const content = <><KnowledgeValue field={field} value={value}/>{value.state !== 'known' && <Badge tone={knowledgeTone(value)}>{value.state === 'conflicting' ? 'Sources differ' : value.state}</Badge>}{sources.length > 0 && <details className="definition-fact-sources"><summary>Sources</summary><SourceReferences includeGameExports={Boolean(corroboration)} sources={sources}/></details>}</>
    return <div className={`definition-row${definitionFactIsWide(field, value) ? ' definition-row--wide' : ''}${value.state === 'conflicting' ? ' definition-row--conflicting' : ''}`} key={field}><dt><StatLabel label={definitionFactLabel(field, value, fields)}/></dt><dd>{renderValue ? renderValue(field, value, content) : content}</dd></div>
  })}</dl> : <InlineNotice title="No definition facts">Unrecorded facts remain unknown. Add a fact in the definition editor.</InlineNotice>}{children}</div></section>
}

export function DefinitionPlanningPanel({ definition }: { definition: CatalogEntity | PersonalDefinition }) {
  const fields: readonly [string, Knowledge<unknown> | undefined][] = [
    ['Slot kinds', definition.slotKinds], ['PP cost', definition.ppCost], ['Requirements', definition.requirements], ['Grants', definition.grants], ['Listed contributions', definition.listedContributions ? { state: 'known', value: definition.listedContributions } : undefined],
  ]
  if (definition.kind === 'monster' && fields.every(([, value]) => value === undefined)) return null
  return <section className="panel" aria-label="Planning fields"><div className="panel__header"><div><h3>Planning fields</h3><p>Values used for validation; missing values stay unknown</p></div></div><div className="panel__body"><dl className="definition-list">{fields.map(([field, value]) => <div className={`definition-row${value?.state === 'conflicting' ? ' definition-row--conflicting' : ''}`} key={field}><dt><StatLabel label={field}/></dt><dd>{value ? <><KnowledgeValue field={field} value={value}/>{value.state !== 'known' && <Badge tone={knowledgeTone(value)}>{value.state}</Badge>}</> : 'Not supplied'}</dd></div>)}</dl></div></section>
}

export function DefinitionSourcesPanel({ sources, collapsed = false, children }: { sources: readonly SourceRef[]; collapsed?: boolean; children?: ReactNode }) {
  const displayed = visibleSources(sources)
  if (sources.length > 0 && displayed.length === 0 && !children) return null
  const content = <>{displayed.length ? displayed.map((source, index) => <div className="source-claim" key={`${source.sourceId}:${source.locator ?? ''}:${index}`}><span className="source-claim__line"/><SourceSummary source={source}/></div>) : sources.length === 0 ? <InlineNotice title="No recorded sources">Source and applicability have not been recorded.</InlineNotice> : null}{children}</>
  return <section className="panel" aria-label="Source trail">{collapsed ? <details className="panel__body"><summary>Source and version details</summary>{content}</details> : <><div className="panel__header"><h3>Source trail</h3></div><div className="panel__body">{content}</div></>}</section>
}

export function DefinitionClaimsPanel({ claims }: { claims: readonly CatalogClaim[] }) {
  return <section className="panel" aria-label="Imported claims"><div className="panel__header"><div><h3>Imported claims</h3><p>Original auxiliary facts from the source definition</p></div></div><div className="panel__body">{claims.length ? claims.map((claim, index) => <div className="source-claim" key={`${claim.field}:${index}`}><span className="source-claim__line"/><div><strong>{claim.field}</strong><KnowledgeValue field={claim.field} value={claim.value}/><SourceReferences sources={claim.sources}/></div></div>) : <InlineNotice title="No separate claims">No auxiliary claims were imported. Field-level claims appear with their values above.</InlineNotice>}</div></section>
}
