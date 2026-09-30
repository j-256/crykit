import type { CSSProperties, ReactNode } from 'react'
import { nativeDefinitionLabel, nativeIdentity, nativeRecord, nativeRelationships, nativeSourceRecord, type NativeRelationship } from '../domain/native-game'
import type { CatalogEntity, CatalogSnapshot, EntityRef, JsonValue, Knowledge } from '../domain/types'
import { Badge } from './components'
import { Icon, type IconName } from './icons'
import { KnowledgeValue } from './KnowledgeValue'
import { CatalogArtwork } from './WikiSprite'
import { DefinitionLink } from './NavigationLink'

const UNKNOWN: Knowledge<JsonValue> = Object.freeze({ state: 'unknown' })
const ATTRIBUTE_LABELS: Readonly<Record<string, string>> = Object.freeze({ Str: 'Strength', Vit: 'Vitality', Dex: 'Dexterity', Agi: 'Agility', Mnd: 'Mind', Spi: 'Spirit', Spd: 'Speed', Lck: 'Luck' })
const COMBAT_LABELS: Readonly<Record<string, string>> = Object.freeze({ 'Physical attack input': 'Attack', 'Physical defense input': 'Defense', 'Magical defense input': 'Magic defense', 'Physical accuracy rating input': 'Accuracy rating', 'Physical critical chance input': 'Critical chance', 'Physical evasion rating input': 'Evasion rating', 'Physical critical damage input': 'Critical damage', 'Physical variance input': 'Attack variance', 'Physical penetration input': 'Physical penetration', 'Magical penetration input': 'Magical penetration' })

export function isNativeEnemy(entity: CatalogEntity): boolean {
  return entity.kind === 'monster' && nativeIdentity(entity)?.database === 'monster' && Boolean(nativeSourceRecord(entity))
}

function EnemyMetric({ entity, field, label, className = '' }: { entity: CatalogEntity; field: string; label: string; className?: string }) {
  const value = entity.fields[field] ?? UNKNOWN
  const numeric = value.state === 'known' && typeof value.value === 'number'
  return <div className={`enemy-metric ${className}`} data-numeric={numeric || undefined}><dt>{label}</dt><dd><KnowledgeValue compact field={field} value={value}/></dd></div>
}

export function NativeEnemyHero({ catalog, entity, name, description, meta }: { catalog: CatalogSnapshot; entity: CatalogEntity; name: ReactNode; description?: ReactNode; meta?: ReactNode }) {
  const vitalDigits = Math.max(1, ...['Level', 'HP', 'MP'].map(field => { const value = entity.fields[field]; return value?.state === 'known' && typeof value.value === 'number' ? String(value.value).length : 1 }))
  const boss = entity.fields.Boss
  const location = nativeRelationships(catalog, entity).find(link => link.label === '/LocationBiomeID')
  return <header className="enemy-hero">
    <div className="enemy-hero__identity"><div className="enemy-hero__art"><CatalogArtwork catalogId={catalog.id} detailed entity={entity}/></div><div className="enemy-hero__copy"><p className="eyebrow">Bestiary{boss?.state === 'known' && boss.value === true ? ' / Boss' : ''}</p>{name}<div className="reference-card__meta"><Badge>{nativeDefinitionLabel(entity)}</Badge>{meta}{boss && (boss.state === 'unknown' || boss.state === 'conflicting') && <Badge tone="warning">Boss status unresolved</Badge>}</div>{description}</div></div>
    <dl aria-label="Enemy overview" className="enemy-vitals" style={{ '--vital-digits': vitalDigits } as CSSProperties}><EnemyMetric entity={entity} field="Level" label="Level"/><EnemyMetric className="enemy-metric--hp" entity={entity} field="HP" label="HP"/><EnemyMetric className="enemy-metric--mp" entity={entity} field="MP" label="MP"/></dl>
    <div className="enemy-hero__footer"><dl aria-label="Enemy rewards" className="enemy-rewards"><EnemyMetric entity={entity} field="Experience" label="EXP"/><EnemyMetric entity={entity} field="JP reward" label="JP"/><EnemyMetric className="enemy-metric--money" entity={entity} field="Money (copper)" label="Money"/></dl>{location?.name && <span className="enemy-location"><Icon name="compass"/>{location.name}</span>}</div>
  </header>
}

function EnemySection({ title, icon, children, className = '' }: { title: string; icon: IconName; children: ReactNode; className?: string }) {
  return <section aria-label={title} className={`enemy-section ${className}`}><h3><Icon name={icon}/>{title}</h3>{children}</section>
}

function StatGrid({ entity, field, labels }: { entity: CatalogEntity; field: string; labels: Readonly<Record<string, string>> }) {
  const value = entity.fields[field] ?? UNKNOWN
  if (value.state !== 'known' || !nativeRecord(value.value)) return <KnowledgeValue field={field} value={value}/>
  const values = value.value
  const keys = [...Object.keys(labels).filter(key => Object.hasOwn(values, key)), ...Object.keys(values).filter(key => !Object.hasOwn(labels, key))]
  return <dl className="enemy-stat-grid">{keys.map(key => { const number = values[key]!; return <div key={key}><dt>{labels[key] ?? key}</dt><dd><KnowledgeValue value={{ state: 'known', value: number }}/></dd></div> })}</dl>
}

export function NativeEnemyStats({ entity }: { entity: CatalogEntity }) {
  return <div aria-label="Enemy stats" className="enemy-stats" role="region"><EnemySection icon="shield" title="Combat inputs"><p className="enemy-section__note">Raw database values</p><StatGrid entity={entity} field="Raw combat inputs" labels={COMBAT_LABELS}/></EnemySection><EnemySection icon="spark" title="Attributes"><p className="enemy-section__note">Raw database values</p><StatGrid entity={entity} field="Raw attributes" labels={ATTRIBUTE_LABELS}/></EnemySection></div>
}

function definitionRef(catalog: CatalogSnapshot, link: NativeRelationship): EntityRef | undefined {
  return link.targetId ? { kind: 'catalog', catalogId: catalog.id, catalogRevisionId: catalog.revisionId, entityId: link.targetId as CatalogEntity['id'] } : undefined
}

function NativeLink({ catalog, link, onOpenDefinition, artwork = false }: { catalog: CatalogSnapshot; link?: NativeRelationship; onOpenDefinition: (ref: EntityRef) => void; artwork?: boolean }) {
  const ref = link && definitionRef(catalog, link)
  const target = link?.targetId ? catalog.entities[link.targetId] : undefined
  return ref ? <DefinitionLink className="enemy-definition-link" definitionRef={ref} onOpenDefinition={onOpenDefinition}>{artwork && target && <CatalogArtwork catalogId={catalog.id} compact entity={target}/>}<span>{link?.name ?? 'Unnamed definition'}</span></DefinitionLink> : <span className="enemy-unresolved">Definition unresolved{link ? ` (${link.database} #${link.databaseId})` : ''}</span>
}

function EnemyLoot({ catalog, entity, field, relationships, onOpenDefinition }: { catalog: CatalogSnapshot; entity: CatalogEntity; field: 'ItemDrops' | 'ItemSteals'; relationships: readonly NativeRelationship[]; onOpenDefinition: (ref: EntityRef) => void }) {
  const record = nativeSourceRecord(entity)!
  const loot = record[field]
  const steals = field === 'ItemSteals'
  return <EnemySection className="enemy-loot" icon={steals ? 'chest' : 'box'} title={steals ? 'Steals' : 'Drops'}>
    {!Array.isArray(loot) ? <p className="enemy-section__note">Loot data is unresolved.</p> : loot.length === 0 ? <p className="enemy-section__note">None listed in this record.</p> : <div className={`enemy-loot-table${steals ? ' enemy-loot-table--steals' : ''}`}><table><thead><tr><th>Item</th><th>Availability</th>{steals && <th>Success</th>}</tr></thead><tbody>{loot.map((entry, index) => {
      const link = relationships.find(link => link.label.startsWith(`/${field}/${index}/`))
      const item = nativeRecord(entry) ? entry : undefined
      return <tr key={index}><td><NativeLink artwork catalog={catalog} link={link} onOpenDefinition={onOpenDefinition}/></td><td><span aria-hidden="true" className="enemy-loot-rate-label">Availability</span><KnowledgeValue value={typeof item?.LootChance === 'number' ? { state: 'known', value: `${item.LootChance}%` } : UNKNOWN}/></td>{steals && <td><span aria-hidden="true" className="enemy-loot-rate-label">Success</span><KnowledgeValue value={typeof item?.StealChance === 'number' ? { state: 'known', value: `${item.StealChance}%` } : UNKNOWN}/></td>}</tr>
    })}</tbody></table></div>}
  </EnemySection>
}

export function NativeEnemyBehavior({ catalog, entity, onOpenDefinition, describeConditions }: { catalog: CatalogSnapshot; entity: CatalogEntity; onOpenDefinition: (ref: EntityRef) => void; describeConditions: (value: JsonValue) => JsonValue }) {
  const record = nativeSourceRecord(entity)!
  const relationships = nativeRelationships(catalog, entity)
  const actions = record.Actions
  return <div className="enemy-behavior"><div className="enemy-loot-grid"><EnemyLoot catalog={catalog} entity={entity} field="ItemDrops" relationships={relationships} onOpenDefinition={onOpenDefinition}/><EnemyLoot catalog={catalog} entity={entity} field="ItemSteals" relationships={relationships} onOpenDefinition={onOpenDefinition}/></div>
    <p className="enemy-loot-note">Availability is the loot entry's chance. Steal success is a separate per-attempt value.</p>
    <EnemySection icon="sword" title="Actions"><p className="enemy-section__note">Database priorities and weights are shown as recorded. Weights are not percentages.</p><div className="enemy-actions">{!Array.isArray(actions) ? <p>Action data is unresolved.</p> : actions.length === 0 ? <p>None listed in this record.</p> : actions.map((entry, index) => {
      const action = nativeRecord(entry) ? entry : undefined
      const link = relationships.find(link => link.label === `/Actions/${index}/AbilityID`)
      const conditions = action?.Conds
      return <article className="enemy-action" key={index}><div className="enemy-action__header"><NativeLink catalog={catalog} link={link} onOpenDefinition={onOpenDefinition}/><dl className="enemy-action__priority"><div><dt>Priority</dt><dd><KnowledgeValue value={typeof action?.Priority === 'number' ? { state: 'known', value: action.Priority } : UNKNOWN}/></dd></div><div><dt>Weight</dt><dd><KnowledgeValue value={typeof action?.Weight === 'number' ? { state: 'known', value: action.Weight } : UNKNOWN}/></dd></div></dl></div>{Array.isArray(conditions) && conditions.length === 0 ? <p className="enemy-action__conditions">No additional conditions</p> : <details className="enemy-action__conditions"><summary>Action conditions</summary><KnowledgeValue value={conditions === undefined ? UNKNOWN : { state: 'known', value: describeConditions(conditions) }}/></details>}</article>
    })}</div></EnemySection>
  </div>
}
