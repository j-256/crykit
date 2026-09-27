import { compactKnowledge, decisionFacts, hasNameEvidenceOnly, sourcePpLabel } from './build-evidence'
import { definitionKindLabel, type DefinitionOption } from './definitions'
import { KnowledgeValue, SourceReferences } from './KnowledgeValue'

export function BuildSelectionFacts({ option }: { option: DefinitionOption }) {
  const facts = decisionFacts(option.record)
  return <span className="build-selection-facts">{facts.length ? facts.slice(0, 4).map(({ label, value }) => `${label}: ${compactKnowledge(value)}`).join(' · ') : hasNameEvidenceOnly(option.record) ? 'Name evidence only; stats and effects unknown' : option.description ?? 'Stats and effects not recorded'}</span>
}

export function BuildSelectionDetails({ option, comparedWith, alternatives = [] }: { option: DefinitionOption; comparedWith?: DefinitionOption; alternatives?: readonly DefinitionOption[] }) {
  const facts = decisionFacts(option.record)
  const previous = comparedWith && comparedWith.key !== option.key ? decisionFacts(comparedWith.record) : undefined
  const labels = [...new Set([...facts.map((fact) => fact.label), ...(previous?.map((fact) => fact.label) ?? [])])]
  return <div className="build-selection-details">
    <div className="cluster"><strong>{option.name}</strong><small>{definitionKindLabel(option.kind)}{['passive', 'innate'].includes(option.kind) ? ` · ${sourcePpLabel(option)}` : ''}</small></div>
    {option.kind === 'innate' && <p className="field__hint">Innate effect. Selecting it does not establish that it is learnable or equipable as a passive under your ruleset.</p>}
    {alternatives.length > 0 && <p className="field__hint">Similar spelling: {alternatives.map((other) => other.name).join(', ')}. These are separate source records; shared identity is unconfirmed. Inventory links are kept separate.</p>}
    {option.description && <p>{option.description}</p>}
    {labels.length > 0 && <table className="build-fact-table"><caption>Source facts{previous ? ` compared with ${comparedWith!.name}` : ''}</caption><thead><tr><th>Field</th>{previous && <th>{comparedWith!.name}</th>}<th>{option.name}</th></tr></thead><tbody>{labels.map((label) => <tr key={label}><th>{label}</th>{previous && <td><KnowledgeValue compact value={previous.find((fact) => fact.label === label)?.value ?? { state: 'unknown' }}/></td>}<td><KnowledgeValue compact value={facts.find((fact) => fact.label === label)?.value ?? { state: 'unknown' }}/></td></tr>)}</tbody></table>}
    <p className="field__hint">Listed source values are not calculated character totals. Platform, mod effects, and permissions still need evidence.</p>
    <details><summary>All reference fields & sources</summary><dl className="definition-list">{Object.entries(option.record.fields).map(([label, value]) => <div className="definition-row" key={label}><dt>{label}</dt><dd><KnowledgeValue showSources value={value}/></dd></div>)}{option.ppCost && <div className="definition-row"><dt>Source PP</dt><dd><KnowledgeValue showSources value={option.ppCost}/></dd></div>}</dl><p className="field__hint">{option.sourceLabel}</p><SourceReferences sources={option.record.sources}/></details>
  </div>
}
