import { CURRENT_CATALOG } from '../catalog/bundled'
import { referenceGuidance } from '../catalog/reference-guidance'
import { ReferenceGuidance } from './ReferenceGuidance'
import { nativeDescription, referenceDescription } from '../catalog/native-description'
import { nativeMechanic } from '../catalog/native-mechanics'
import { nativeSourceRecord } from '../domain/native-game'
import type { CatalogEntity, CatalogSnapshot } from '../domain/types'
import { MoneyText } from './MoneyText'
import { SourceReferences } from './KnowledgeValue'
import { Sources } from './Sources'
import { externalSources } from './source-display'
import { corroboratedFact } from '../catalog/source-corroboration'
import { bundledModIdentity } from '../domain/bundled-mods'

export function descriptionTextMatches(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left?.trim() && right?.trim() && left.replace(/\s+/g, ' ').trim() === right.replace(/\s+/g, ' ').trim())
}

export function ReferenceDescription({ entity, catalog, compact = false, fallback = 'No description supplied.', hideGeneratedSummary = false }: { entity: CatalogEntity; catalog?: CatalogSnapshot; compact?: boolean; fallback?: string; hideGeneratedSummary?: boolean }) {
  const record = nativeSourceRecord(entity)
  const native = nativeDescription(entity)
  const guidanceCatalog = catalog ?? CURRENT_CATALOG
  const supplemental = referenceGuidance(guidanceCatalog, entity, 'description')
  const generatedSummary = record && native && !record.Description && !native.lines.length
  // A source-record inventory is useful in evidence, but it is not a gameplay description
  const description = (hideGeneratedSummary || supplemental.length > 0) && generatedSummary ? undefined : referenceDescription(entity)
  const mechanic = nativeMechanic(entity)
  const field = entity.fields.Description
  const sourcesFor = (text: string) => {
    const matchesField = field?.state === 'known' && typeof field.value === 'string' && descriptionTextMatches(field.value, text)
    if (matchesField && catalog && !bundledModIdentity(entity) && corroboratedFact({ catalog, entity }, 'Description', field)) return []
    return externalSources(matchesField && field.sources?.length ? field.sources : entity.sources)
  }
  const sources = sourcesFor(description ?? '')
  const text = <p style={{ whiteSpace: 'pre-line' }}><MoneyText>{description ?? fallback}</MoneyText></p>
  return <div className="reference-description">
    {(description || supplemental.length === 0) && (!compact && description && !native?.lines.length && !mechanic && sources.length ? <Sources anchor={text} label="Sources for Description"><SourceReferences sources={sources}/></Sources> : text)}
    {(!compact || !native?.lines.length) && <ReferenceGuidance catalog={guidanceCatalog} compact={compact} entity={entity} kind="description"/>}
    {!compact && <ReferenceGuidance catalog={guidanceCatalog} entity={entity} kind="master-directions"/>}
    {!compact && mechanic?.calculationLinks?.length ? <p>{mechanic.calculationLinks.map(link => <a key={link.href} href={link.href} rel="noreferrer" target="_blank">{link.label} </a>)}</p> : null}
  </div>
}
