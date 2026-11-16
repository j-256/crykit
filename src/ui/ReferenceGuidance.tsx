import { referenceGuidance, REFERENCE_GUIDANCE_RIGHTS, type ReferenceGuidanceKind } from '../catalog/reference-guidance'
import type { CatalogEntity, CatalogSnapshot, PersonalDefinition } from '../domain/types'
import { MoneyText } from './MoneyText'
import { SourceReferences } from './KnowledgeValue'
import { Sources } from './Sources'

const LABELS: Readonly<Record<ReferenceGuidanceKind, string>> = Object.freeze({ description: 'Description', directions: 'Directions', 'master-directions': 'Class master' })

export function ReferenceGuidance({ catalog, entity, kind, compact = false }: { catalog: CatalogSnapshot; entity: CatalogEntity | PersonalDefinition; kind: ReferenceGuidanceKind; compact?: boolean }) {
  const records = referenceGuidance(catalog, entity, kind)
  if (!records.length) return null
  return <div className="reference-guidance">
    {kind === 'master-directions' && <h4>Class master</h4>}
    {records.map(record => {
      const text = <p style={{ whiteSpace: 'pre-line' }}><MoneyText>{record.text}</MoneyText></p>
      return compact ? <div key={record.text}>{text}</div> : <Sources anchor={text} key={record.text} label={`Sources for ${LABELS[kind]}`}><SourceReferences sources={record.sources}/><p><a href={REFERENCE_GUIDANCE_RIGHTS.licenseUrl} rel="noreferrer" target="_blank">{REFERENCE_GUIDANCE_RIGHTS.attribution} · {REFERENCE_GUIDANCE_RIGHTS.license}</a></p></Sources>
    })}
  </div>
}
