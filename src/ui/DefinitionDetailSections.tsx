import type { ReactNode } from 'react'
import type { CatalogClaim, CatalogEntity, Knowledge, PersonalDefinition, SourceRef } from '../domain/types'
import { Badge, InlineNotice } from './components'
import { KnowledgeValue, SourceReferences, SourceSummary } from './KnowledgeValue'
import { knowledgeTone } from './model'

export function DefinitionFactsPanel({ facts, renderValue, children }: { facts: readonly (readonly [string, Knowledge<unknown>])[]; renderValue?: (field: string, value: Knowledge<unknown>, content: ReactNode) => ReactNode; children?: ReactNode }) {
  return <section className="panel" aria-label="Definition facts"><div className="panel__header"><h3>Definition facts</h3></div><div className="panel__body">{facts.length ? <dl className="definition-list">{facts.map(([field, value]) => {
    const content = <><KnowledgeValue field={field} value={value}/><Badge tone={knowledgeTone(value)}>{value.state === 'conflicting' ? 'Sources differ' : value.state}</Badge>{value.state === 'known' && Boolean(value.sources?.length) && <details className="definition-fact-sources"><summary>Sources</summary><SourceReferences sources={value.sources!}/></details>}</>
    return <div className={`definition-row${value.state === 'conflicting' ? ' definition-row--conflicting' : ''}`} key={field}><dt>{field}</dt><dd>{renderValue ? renderValue(field, value, content) : content}</dd></div>
  })}</dl> : <InlineNotice title="No definition facts">Unrecorded facts remain unknown. Add a fact in the definition editor.</InlineNotice>}{children}</div></section>
}

export function DefinitionPlanningPanel({ definition }: { definition: CatalogEntity | PersonalDefinition }) {
  const fields: readonly [string, Knowledge<unknown> | undefined][] = [
    ['Slot kinds', definition.slotKinds], ['PP cost', definition.ppCost], ['Requirements', definition.requirements], ['Grants', definition.grants], ['Listed contributions', definition.listedContributions ? { state: 'known', value: definition.listedContributions } : undefined],
  ]
  return <section className="panel" aria-label="Planning fields"><div className="panel__header"><div><h3>Planning fields</h3><p>Values used for validation; missing values stay unknown</p></div></div><div className="panel__body"><dl className="definition-list">{fields.map(([field, value]) => <div className={`definition-row${value?.state === 'conflicting' ? ' definition-row--conflicting' : ''}`} key={field}><dt>{field}</dt><dd>{value ? <><KnowledgeValue field={field} value={value}/><Badge tone={knowledgeTone(value)}>{value.state}</Badge></> : 'Not supplied'}</dd></div>)}</dl></div></section>
}

export function DefinitionSourcesPanel({ sources, children }: { sources: readonly SourceRef[]; children?: ReactNode }) {
  return <section className="panel" aria-label="Source trail"><div className="panel__header"><h3>Source trail</h3></div><div className="panel__body">{sources.length ? sources.map((source, index) => <div className="source-claim" key={`${source.sourceId}:${source.locator ?? ''}:${index}`}><span className="source-claim__line"/><SourceSummary source={source}/></div>) : <InlineNotice title="No recorded sources">Source and applicability have not been recorded.</InlineNotice>}{children}</div></section>
}

export function DefinitionClaimsPanel({ claims }: { claims: readonly CatalogClaim[] }) {
  return <section className="panel" aria-label="Imported claims"><div className="panel__header"><div><h3>Imported claims</h3><p>Original auxiliary facts from the source definition</p></div></div><div className="panel__body">{claims.length ? claims.map((claim, index) => <div className="source-claim" key={`${claim.field}:${index}`}><span className="source-claim__line"/><div><strong>{claim.field}</strong><KnowledgeValue value={claim.value}/>{claim.sources.map((source, index) => <SourceSummary key={index} source={source}/>)}</div></div>) : <InlineNotice title="No separate claims">No auxiliary claims were imported. Field-level claims appear with their values above.</InlineNotice>}</div></section>
}
