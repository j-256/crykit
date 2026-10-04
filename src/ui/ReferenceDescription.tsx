import { nativeDescription, referenceDescription } from '../catalog/native-description'
import { nativeMechanic } from '../catalog/native-mechanics'
import { nativeDisplayDescription, nativeRecord } from '../domain/native-game'
import type { CatalogEntity } from '../domain/types'
import { MoneyText } from './MoneyText'

export function ReferenceDescription({ entity, compact = false, originalDescriptionReplaced = false, fallback = 'No description supplied.' }: { entity: CatalogEntity; compact?: boolean; originalDescriptionReplaced?: boolean; fallback?: string }) {
  const native = nativeDescription(entity)
  const original = nativeDisplayDescription(entity)
  const description = referenceDescription(entity)
  const mechanic = nativeMechanic(entity)
  const inheritedDescription = nativeRecord(entity.legacy) && entity.legacy.nativeDescriptionSupplemental === true
  return <div className="reference-description">
    <p style={{ whiteSpace: 'pre-line' }}><MoneyText>{description ?? fallback}</MoneyText></p>
    {!compact && mechanic?.calculationLinks?.length ? <p>{mechanic.calculationLinks.map(link => <a key={link.href} href={link.href} rel="noreferrer" target="_blank">{link.label} </a>)}</p> : null}
    {!compact && inheritedDescription && !originalDescriptionReplaced && native?.lines.length && original && original !== description ? <details><summary>Guide notes</summary><p style={{ whiteSpace: 'pre-line' }}><MoneyText>{original}</MoneyText></p></details> : null}
  </div>
}
