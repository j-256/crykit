import { nativeDescription, referenceDescription } from '../catalog/native-description'
import { nativeReferenceAlternatives, nativeReferenceLink } from '../catalog/native-reference-links'
import type { AcquisitionGuidanceProjection } from '../catalog/acquisition-guidance'
import type { NativeFieldFact } from '../catalog/native-field-facts'
import { nativeMechanic } from '../catalog/native-mechanics'
import { nativeDisplayDescription } from '../domain/native-game'
import type { CatalogEntity, CatalogSnapshot, EntityRef, Knowledge } from '../domain/types'
import { Button } from './components'
import { KnowledgeValue, SourceReferences } from './KnowledgeValue'
import { MoneyText } from './MoneyText'
import { descriptionTextMatches, referenceNarrativeDescription } from './ReferenceDescription'

export function ReferenceSourceDetails({ catalog, entity, guidance, nativeFacts, archivedFacts, onOpenDefinition }: { catalog: CatalogSnapshot; entity: CatalogEntity; guidance: AcquisitionGuidanceProjection; nativeFacts: readonly NativeFieldFact[]; archivedFacts: readonly (readonly [string, Knowledge<unknown>])[]; onOpenDefinition: (ref: EntityRef) => void }) {
  const native = nativeDescription(entity)
  const mechanic = nativeMechanic(entity)
  const original = nativeDisplayDescription(entity)
  const displayedDescriptions = [referenceDescription(entity), referenceNarrativeDescription(entity), ...native?.lines ?? []]
  const descriptionIsVisible = (value: string) => displayedDescriptions.some(description => descriptionTextMatches(description, value))
  const originalKnowledge = (field: string, value: Knowledge<unknown>) => value.state === 'known' && typeof value.value === 'string' && descriptionIsVisible(value.value) ? <SourceReferences includeGameExports sources={value.sources ?? []}/> : <KnowledgeValue showSources field={field} value={value}/>
  const link = nativeReferenceLink(catalog, entity.id)
  const counterpart = link && catalog.entities[link.targetId]
  const alternatives = nativeReferenceAlternatives(catalog, entity.id)
  return <>
    {mechanic && <details><summary>Original guide and native evidence</summary><p><MoneyText>{mechanic.originalDescription}</MoneyText></p><dl className="definition-list">{Object.entries(mechanic.originalFields).map(([field, value]) => <div className="definition-row definition-row--wide" key={field}><dt>{field}</dt><dd><KnowledgeValue showSources field={field} value={value}/></dd></div>)}</dl><p>{mechanic.evidence.join('; ')}</p></details>}
    {counterpart && <div className="source-claim"><p>{link.relation === 'same-definition' ? 'This source entry has a verified Windows game definition.' : 'This command belongs to a native class definition.'}</p><Button tone="quiet" onClick={() => onOpenDefinition({ kind: 'catalog', catalogId: catalog.id, catalogRevisionId: catalog.revisionId, entityId: counterpart.id })}>View {counterpart.name}{link.relation === 'command-of-class' ? ' class' : ' game definition'}</Button><p>{link.basis}</p></div>}
    {alternatives.length > 0 && <details><summary>Related source entries</summary>{alternatives.map(alternative => <div className="source-claim" key={alternative.sourceId}><Button tone="quiet" onClick={() => onOpenDefinition({ kind: 'catalog', catalogId: catalog.id, catalogRevisionId: catalog.revisionId, entityId: catalog.entities[alternative.sourceId]!.id })}>{catalog.entities[alternative.sourceId]!.name}</Button><p>{alternative.basis}</p></div>)}</details>}
    {native?.lines.length && original && !descriptionIsVisible(original) ? <details><summary>Original source description</summary><p style={{ whiteSpace: 'pre-line' }}><MoneyText>{original}</MoneyText></p></details> : null}
    {guidance.originalGuides.length > 0 && <details><summary>Original acquisition notes</summary><dl className="definition-list">{guidance.originalGuides.map(guide => <div className="definition-row definition-row--wide" key={guide.field}><dt>{guide.field}</dt><dd>{originalKnowledge(guide.field, guide.knowledge)}<p>The matching game routes appear under How to obtain.</p><small>{guide.evidence.join('; ')}</small></dd></div>)}</dl></details>}
    {guidance.disagreements.map(difference => <div className="source-claim" key={difference.field}><strong>Acquisition sources differ</strong><p>{difference.summary}</p><KnowledgeValue showSources field={difference.field} value={difference.knowledge}/><small>{difference.evidence.join('; ')}</small></div>)}
    {nativeFacts.length > 0 && <details><summary>Original field claims</summary><dl className="definition-list">{nativeFacts.map(fact => <div className="definition-row" key={fact.field}><dt>{fact.field}</dt><dd><KnowledgeValue showSources field={fact.field} value={fact.original}/>{fact.differs && <p>The Windows game value is shown in Definition facts.</p>}<small>{fact.evidence}</small></dd></div>)}</dl></details>}
    {archivedFacts.length > 0 && <details><summary>Original description fields</summary><dl className="definition-list">{archivedFacts.map(([field, value]) => <div className="definition-row definition-row--wide" key={field}><dt>{field}</dt><dd>{originalKnowledge(field, value)}</dd></div>)}</dl></details>}
  </>
}
