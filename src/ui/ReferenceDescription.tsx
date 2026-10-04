import { nativeDescription, referenceDescription } from '../catalog/native-description'
import { nativeMechanic } from '../catalog/native-mechanics'
import { nativeDisplayDescription, nativeRecord } from '../domain/native-game'
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

export function referenceNarrativeDescription(entity: CatalogEntity): string | undefined {
  const native = nativeDescription(entity)
  const field = entity.fields.Description
  const original = field?.state === 'known' && typeof field.value === 'string' && field.value.trim() ? field.value : nativeDisplayDescription(entity)
  const inheritedDescription = nativeRecord(entity.legacy) && entity.legacy.nativeDescriptionSupplemental === true
  return !nativeMechanic(entity) && inheritedDescription && native?.lines.length && original && original !== referenceDescription(entity) && !native.lines.includes(original) ? original : undefined
}

export function ReferenceDescription({ entity, catalog, compact = false, fallback = 'No description supplied.' }: { entity: CatalogEntity; catalog?: CatalogSnapshot; compact?: boolean; fallback?: string }) {
  const description = referenceDescription(entity)
  const narrative = compact ? undefined : referenceNarrativeDescription(entity)
  const mechanic = nativeMechanic(entity)
  const native = nativeDescription(entity)
  const field = entity.fields.Description
  const sourcesFor = (text: string) => {
    const matchesField = field?.state === 'known' && typeof field.value === 'string' && descriptionTextMatches(field.value, text)
    if (matchesField && catalog && !bundledModIdentity(entity) && corroboratedFact({ catalog, entity }, 'Description', field)) return []
    return externalSources(matchesField && field.sources?.length ? field.sources : entity.sources)
  }
  const sources = sourcesFor(description ?? '')
  const narrativeSources = sourcesFor(narrative ?? '')
  const text = <p style={{ whiteSpace: 'pre-line' }}><MoneyText>{description ?? fallback}</MoneyText></p>
  const narrativeHeading = <h3>Description</h3>
  return <div className="reference-description">
    {!compact && description && !native?.lines.length && !mechanic && sources.length ? <Sources anchor={text} label="Sources for Description"><SourceReferences sources={sources}/></Sources> : text}
    {!compact && mechanic?.calculationLinks?.length ? <p>{mechanic.calculationLinks.map(link => <a key={link.href} href={link.href} rel="noreferrer" target="_blank">{link.label} </a>)}</p> : null}
    {narrative && <section aria-label="Description" className="reference-description__narrative">{narrativeSources.length ? <Sources anchor={narrativeHeading} label="Sources for Description"><SourceReferences sources={narrativeSources}/></Sources> : narrativeHeading}<p style={{ whiteSpace: 'pre-line' }}><MoneyText>{narrative}</MoneyText></p></section>}
  </div>
}
