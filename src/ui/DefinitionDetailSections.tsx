import type { ReactNode } from 'react'
import type { CatalogClaim, CatalogEntity, Knowledge, NumericContribution, PersonalDefinition, SourceRef } from '../domain/types'
import { Badge, InlineNotice } from './components'
import { KnowledgeValue, SourceReferences, SourceSummary, type MoneyFormat } from './KnowledgeValue'
import { knowledgeTone } from './model'
import { definitionFactIsWide, definitionFactLabel, externalSources, isNativeGameSource } from './source-display'
import { StatLabel } from './StatRatings'
import { Icon } from './icons'
import { Sources } from './Sources'
import { NATIVE_SOURCE_PREFIX } from '../domain/native-game'
import { corroboratedFact, type CorroborationTarget } from '../catalog/source-corroboration'
import { bundledModIdentity } from '../domain/bundled-mods'
import { sameValue } from '../domain/definition-values'
import type { NativeFieldFact } from '../catalog/native-field-facts'

const LISTED_FLAT_VALUE_UNIT = 'listed flat value'

function nativePlanningContribution(field: string, contribution: Knowledge<NumericContribution>, facts: readonly NativeFieldFact[]): Knowledge<NumericContribution> {
  for (const fact of facts) {
    if (fact.field !== field || fact.original.state !== 'known' || typeof fact.original.value !== 'number' || fact.value.state !== 'known' || typeof fact.value.value !== 'number') continue
    const original = { ...fact.original, value: { value: fact.original.value, unit: LISTED_FLAT_VALUE_UNIT } }
    if (sameValue(contribution, original)) return { ...fact.value, value: { value: fact.value.value, unit: LISTED_FLAT_VALUE_UNIT } }
  }
  return contribution
}

export function DefinitionFactsPanel({ facts, corroboration, verifiedNativeFacts = [], renderValue, children, moneyFormat = 'coins' }: { facts: readonly (readonly [string, Knowledge<unknown>])[]; corroboration?: CorroborationTarget; verifiedNativeFacts?: readonly Pick<NativeFieldFact, 'field' | 'value'>[]; renderValue?: (field: string, value: Knowledge<unknown>, content: ReactNode) => ReactNode; children?: ReactNode; moneyFormat?: MoneyFormat }) {
  const fields = facts.map(([field]) => field)
  const orderedFacts = [...facts].sort(([left], [right]) => Number(/^cost$/i.test(left)) - Number(/^cost$/i.test(right)))
  const nativeCorroboration = corroboration && !bundledModIdentity(corroboration.entity) ? corroboration : undefined
  return <section className="panel" aria-label="Definition facts"><div className="panel__header"><h3 className="icon-label"><Icon name="book"/>Definition facts</h3></div><div className="panel__body">{facts.length ? <dl className="definition-list definition-facts">{orderedFacts.map(([field, value]) => {
    const verified = value.state === 'known' && (verifiedNativeFacts.some(fact => fact.field === field && sameValue(fact.value, value)) || corroboratedFact(nativeCorroboration, field, value))
    const external = value.state === 'known' && !verified ? externalSources(value.sources ?? []) : []
    const sources = value.state === 'unknown' ? value.sources ?? [] : value.state === 'known' && !verified ? external.length ? external : corroboration && value.sources?.some(isNativeGameSource) ? value.sources : [] : []
    const valueContent = <><KnowledgeValue field={field} moneyFormat={moneyFormat} value={value}/>{(value.state === 'unknown' || value.state === 'conflicting') && <Badge tone={knowledgeTone(value)}>{value.state === 'conflicting' ? 'Sources differ' : value.state}</Badge>}</>
    const content = sources.length > 0 ? <Sources anchor={valueContent} label={`Sources for ${field}`}><SourceReferences includeGameExports sources={sources}/></Sources> : valueContent
    return <div className={`definition-row${definitionFactIsWide(field, value) ? ' definition-row--wide' : ''}${value.state === 'conflicting' ? ' definition-row--conflicting' : ''}`} key={field}><dt><StatLabel label={definitionFactLabel(field, value, fields)}/></dt><dd>{renderValue ? renderValue(field, value, content) : content}</dd></div>
  })}</dl> : <InlineNotice title="No definition facts">Unrecorded facts remain unknown. Add a fact in the definition editor.</InlineNotice>}{children}</div></section>
}

export function DefinitionPlanningPanel({ definition, verifiedNativeFacts = [] }: { definition: CatalogEntity | PersonalDefinition; verifiedNativeFacts?: readonly NativeFieldFact[] }) {
  const passive = definition.kind === 'passive' || definition.kind === 'innate'
  const validatesSelections = passive || definition.kind === 'class' || definition.kind === 'item'
  const candidates: readonly (readonly [string, Knowledge<unknown> | undefined])[] = [
    ['Slot kinds', definition.kind === 'item' ? definition.slotKinds : undefined], ['PP cost', passive ? definition.ppCost : undefined], ['Requirements', validatesSelections ? definition.requirements : undefined], ['Grants', validatesSelections ? definition.grants : undefined], ['Listed contributions', definition.listedContributions ? { state: 'known', value: definition.listedContributions } : undefined],
  ]
  const fields = candidates.filter((entry): entry is readonly [string, Knowledge<unknown>] => entry[1] !== undefined && entry[1].state !== 'notApplicable')
  if (!fields.length) return null
  return <section className="panel" aria-label="Planning fields"><div className="panel__header"><h3>Planning fields</h3></div><div className="panel__body"><dl className="definition-list">{fields.map(([field, value]) => <div className={`definition-row${value.state === 'conflicting' ? ' definition-row--conflicting' : ''}`} key={field}><dt><StatLabel label={field}/></dt><dd><>{field === 'Listed contributions' ? <dl className="definition-list">{Object.entries(definition.listedContributions ?? {}).map(([name, contribution]) => <div className="definition-row" key={name}><dt>{name}</dt><dd><KnowledgeValue field={name} showSources value={nativePlanningContribution(name, contribution, verifiedNativeFacts)}/></dd></div>)}</dl> : <KnowledgeValue field={field} value={value}/>}</>{(value.state === 'unknown' || value.state === 'conflicting') && <Badge tone={knowledgeTone(value)}>{value.state}</Badge>}</dd></div>)}</dl></div></section>
}

export function DefinitionSourcesPanel({ sources, label = 'Sources', uncertain = false, hasExternalContent = false, anchor, children }: { sources: readonly SourceRef[]; label?: string; uncertain?: boolean; hasExternalContent?: boolean; anchor?: ReactNode; children?: ReactNode }) {
  const displayed = [...(uncertain ? sources : externalSources(sources))].sort((left, right) => Number(right.sourceId.startsWith(NATIVE_SOURCE_PREFIX)) - Number(left.sourceId.startsWith(NATIVE_SOURCE_PREFIX)))
  if (!displayed.length && !uncertain && !hasExternalContent) return <>{anchor}</>
  const content = <>{displayed.length ? displayed.map((source, index) => <div className="source-claim" key={`${source.sourceId}:${source.locator ?? ''}:${index}`}><span className="source-claim__line"/><SourceSummary source={source}/></div>) : sources.length === 0 && !hasExternalContent ? <InlineNotice title="No recorded sources">Source and applicability have not been recorded.</InlineNotice> : null}{children}</>
  return <Sources anchor={anchor} label={label}>{content}</Sources>
}

export function DefinitionClaimsPanel({ claims }: { claims: readonly CatalogClaim[] }) {
  return <section className="panel" aria-label="Imported claims"><div className="panel__header"><div><h3>Imported claims</h3><p>Original auxiliary facts from the source definition</p></div></div><div className="panel__body">{claims.length ? claims.map((claim, index) => <div className="source-claim" key={`${claim.field}:${index}`}><span className="source-claim__line"/><div><strong>{claim.field}</strong><KnowledgeValue field={claim.field} value={claim.value}/><SourceReferences includeGameExports sources={claim.sources}/></div></div>) : <InlineNotice title="No separate claims">No auxiliary claims were imported. Field-level claims appear with their values above.</InlineNotice>}</div></section>
}
