import { nativeIdentity, nativeRecord, nativeRelationships, nativeSourceRecord } from '../domain/native-game'
import type { ReactNode } from 'react'
import type { CatalogEntity, CatalogSnapshot, EntityRef, JsonValue } from '../domain/types'
import { DefinitionLink } from './NavigationLink'
import { KnowledgeValue } from './KnowledgeValue'
import { NativeEnemyBehavior } from './NativeEnemyDetails'

const DETAILS = Object.freeze({ ItemDrops: 'Drops', ItemSteals: 'Steals', Actions: 'Enemy actions and conditions', TargetStatuses: 'Target statuses', UserStatuses: 'User statuses', Ingredients: 'Recipe ingredients', Members: 'Encounter members' })
const CONDITION_ENUMS: Readonly<Record<string, string>> = Object.freeze({ CondVar: 'ActionConditionVar', CondEval: 'ActionConditionEval', CondGroup: 'ActionConditionGroup' })

function describeCodes(value: JsonValue, enums: Readonly<Record<string, JsonValue>>): JsonValue {
  if (Array.isArray(value)) return value.map(entry => describeCodes(entry, enums))
  if (!nativeRecord(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    const codebook = enums[CONDITION_ENUMS[key] ?? '']
    const name = nativeRecord(codebook) && typeof entry === 'number' ? codebook[entry] : undefined
    return [key, typeof name === 'string' ? `${name} (code ${entry})` : describeCodes(entry, enums)]
  }))
}

function NativeRelatedDefinitions({ catalog, relationships, onOpenDefinition }: { catalog: CatalogSnapshot; relationships: ReturnType<typeof nativeRelationships>; onOpenDefinition: (ref: EntityRef) => void }) {
  return relationships.length > 0 && <details><summary>Related definitions</summary><ul>{relationships.map(link => <li key={link.label}><small>{link.label.slice(1)}: </small>{link.targetId ? <DefinitionLink definitionRef={{ kind: 'catalog', catalogId: catalog.id, catalogRevisionId: catalog.revisionId, entityId: link.targetId as CatalogEntity['id'] }} onOpenDefinition={onOpenDefinition}>{link.name} ({link.database} #{link.databaseId})</DefinitionLink> : <span>{link.database} #{link.databaseId}: definition unresolved</span>}</li>)}</ul></details>
}

export function NativeClassSourceDetails({ catalog, entity, onOpenDefinition }: { catalog: CatalogSnapshot; entity: CatalogEntity; onOpenDefinition: (ref: EntityRef) => void }) {
  const identity = nativeIdentity(entity)
  const record = nativeSourceRecord(entity)
  if (identity?.database !== 'job' || !record) return null
  return <div className="stack">
    <small>Native {identity.database} #{identity.databaseId}</small>
    {identity.mode !== 'base' && <p>This record is a mode override. It does not establish that this mode or any optional mod is enabled in your Game Setup.</p>}
    <NativeRelatedDefinitions catalog={catalog} relationships={nativeRelationships(catalog, entity)} onOpenDefinition={onOpenDefinition}/>
    <details><summary>Complete native source record</summary><pre className="native-source-record">{JSON.stringify(record, null, 2)}</pre></details>
  </div>
}

export function NativeDefinitionDetails({ catalog, entity, enemyMode, onOpenDefinition, technicalDetails }: { catalog: CatalogSnapshot; entity: CatalogEntity; enemyMode?: string; onOpenDefinition: (ref: EntityRef) => void; technicalDetails?: ReactNode }) {
  const identity = nativeIdentity(entity)
  const record = nativeSourceRecord(entity)
  if (!identity || !record || identity.database === 'job') return null
  const relationships = nativeRelationships(catalog, entity)
  const legacy = nativeRecord(catalog.legacy) ? catalog.legacy : {}
  const enums = nativeRecord(legacy.nativeEnums) ? legacy.nativeEnums : {}
  const related = <NativeRelatedDefinitions catalog={catalog} relationships={relationships} onOpenDefinition={onOpenDefinition}/>
  if (identity.database === 'monster') return <section aria-label="Game details" className="enemy-details">
    {identity.mode !== 'base' && <p className="enemy-scope-note">This is a mode override. It does not establish that this mode or any optional mod is enabled in your Game Setup.</p>}
    <NativeEnemyBehavior catalog={catalog} entity={entity} nativeMode={enemyMode} onOpenDefinition={onOpenDefinition} describeConditions={value => describeCodes(value, enums)}/>
    <details className="enemy-technical"><summary>Technical details <span>Engine fields and related definitions</span></summary><div className="stack">{entity.aliases.length > 0 && <p>Aliases: {entity.aliases.join(', ')}</p>}<p>Stats are raw database inputs. Difficulty, automatic stat generation, modes, and mods can change effective battle values. Test records and repeated enemy names retain distinct IDs.</p>{technicalDetails}{related}</div></details>
  </section>
  return <section aria-label="Game details" className="panel"><div className="panel__header"><h3>Game details</h3></div><div className="panel__body stack">
    {identity.mode !== 'base' && <p>This record is a mode override. It does not establish that this mode or any optional mod is enabled in your Game Setup.</p>}
    {Object.entries(DETAILS).filter(([key]) => Object.hasOwn(record, key)).map(([key, title]) => <details key={key}><summary>{title}</summary>{(key === 'ItemDrops' || key === 'ItemSteals') && Array.isArray(record[key]) && record[key].length > 0 ? <div className="structured-value__table native-loot-table"><table><thead><tr><th>Item</th><th>Availability (%)</th>{key === 'ItemSteals' && <th>Success (%)</th>}</tr></thead><tbody>{record[key].filter(nativeRecord).map((loot, index) => {
      const link = relationships.find(link => link.label.startsWith(`/${key}/${index}/`))
      return <tr key={index}><td>{link?.targetId ? <DefinitionLink definitionRef={{ kind: 'catalog', catalogId: catalog.id, catalogRevisionId: catalog.revisionId, entityId: link.targetId as CatalogEntity['id'] }} onOpenDefinition={onOpenDefinition}>{link.name}</DefinitionLink> : <span>Unresolved loot</span>}</td><td><KnowledgeValue value={typeof loot.LootChance === 'number' ? { state: 'known', value: loot.LootChance } : { state: 'unknown' }}/></td>{key === 'ItemSteals' && <td><KnowledgeValue value={typeof loot.StealChance === 'number' ? { state: 'known', value: loot.StealChance } : { state: 'unknown' }}/></td>}</tr>
    })}</tbody></table></div> : <KnowledgeValue value={{ state: 'known', value: describeCodes(record[key]!, enums) }}/>}</details>)}
    {related}
  </div></section>
}
