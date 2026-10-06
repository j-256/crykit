import treeIdentities from './class-tree-identities.json' with { type: 'json' }
import { NATIVE_GAME_DATA } from './native-game'
import { bundledModRecord } from '../domain/bundled-mods'
import { CLASS_FIELDS } from '../domain/crystal-edit'
import { gameRecordFacts } from '../domain/game-record-facts'
import { definitionWithMechanics } from '../domain/mechanics-facts'
import { nativeIdentity, nativeRecord, nativeSourceRecord } from '../domain/native-game'
import type { CatalogEntity, CatalogSnapshot, JsonValue, Knowledge } from '../domain/types'

function sourcedEntity(entity: CatalogEntity): CatalogEntity {
  const record = nativeSourceRecord(entity) ?? bundledModRecord(entity)
  if (!record) return entity
  const recordField = entity.fields['Native source record'] ?? entity.fields['Crystal Edit source record']
  const source = recordField?.state === 'known' ? recordField.sources?.[0] ?? entity.sources[0]! : entity.sources[0]!
  const facts = gameRecordFacts(record, entity.kind, source, NATIVE_GAME_DATA.enums)
  const fields: Record<string, Knowledge<JsonValue>> = { ...entity.fields }
  delete fields['Wiki coverage']
  if (entity.kind === 'item' && facts['Cost (copper)']) {
    delete fields.Cost
    fields['Cost (copper)'] = facts['Cost (copper)']!
  }
  for (const [field, value] of Object.entries(fields)) {
    if (value.state === 'unknown' && value.reason?.startsWith('Native ') && value.reason.endsWith('is null; effective meaning is unresolved')) fields[field] = { state: 'known', value: null, sources: value.sources }
  }
  for (const field of ['Description', 'Cost', 'Type', 'Learning cost', 'HP cost', 'MP cost', 'AP cost', 'CT cost', 'CD cost', 'Stat modifiers', 'Ability modifiers', 'Hands', 'Unique']) {
    if (facts[field] && (field !== 'Description' || fields.Description?.state !== 'known')) fields[field] = facts[field]!
  }
  if (entity.kind === 'class' && fields[CLASS_FIELDS.equipment]?.state === 'known') {
    if (fields.Weapons?.state === 'unknown') delete fields.Weapons
    if (fields.Armor?.state === 'unknown') delete fields.Armor
  }
  if (entity.kind === 'class' && record.IsNotCrystalJob === undefined) delete fields['Excluded from crystal count']
  if (fields['Source mod']?.state === 'unknown') fields['Source mod'] = { state: 'known', value: 'Base game', sources: [source] }
  const { slotKinds: _slots, ...sourced } = entity
  const projected: CatalogEntity = definitionWithMechanics({ ...sourced, fields }, [])
  const { slotKinds: _projectedSlots, ...result } = projected
  return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined)) as unknown as CatalogEntity
}

export function reconcileNativeSourceIdentities(base: CatalogSnapshot): CatalogSnapshot {
  const entities: Record<string, CatalogEntity> = { ...base.entities }
  const bindings: Record<string, string> = { ...NATIVE_GAME_DATA.identityBindings }
  // Tree coordinates establish identities only for the exact databases they were reviewed against
  // Accepting a changed source here could bind a valid-looking skill to a different native record
  for (const [family, digest] of Object.entries(treeIdentities.databaseSha256)) if (NATIVE_GAME_DATA.source.files.find(file => file.path === `Database/${family}.dat`)?.sha256 !== digest) throw new Error('Base skill identity evidence does not match native source hashes')
  for (const identity of Object.values(treeIdentities.classes)) for (const node of identity.nodes) {
    const family = node.nodeType === 2 ? 'ability' : 'passive'
    const job = (NATIVE_GAME_DATA.databases.job as readonly JsonValue[]).find(value => nativeRecord(value) && value.ID === identity.nativeJobId)
    const cell = nativeRecord(job) && Array.isArray(job.LearnTree) && Array.isArray(job.LearnTree[node.column]) ? job.LearnTree[node.column][node.row] : undefined
    const native = entities[node.entityId]
    if (!nativeRecord(cell) || cell.DataID !== node.dataId || cell.NodeType !== node.nodeType || bindings[`${family}:${node.dataId}`] !== node.entityId || !native || nativeSourceRecord(native)?.Name !== node.name) throw new Error(`Base skill identity evidence disagrees: ${node.entityId}`)
    if (native.kind !== node.kind) entities[node.entityId] = { ...native, kind: node.kind as CatalogEntity['kind'] }
    bindings[`${family}:${node.dataId}`] = node.entityId
  }
  return { ...base, entities, legacy: { ...(nativeRecord(base.legacy) ? base.legacy : {}), nativeIdentityBindings: bindings } }
}

export function projectSourceCatalog(base: CatalogSnapshot): CatalogSnapshot {
  const entities: Record<string, CatalogEntity> = { ...base.entities }
  const modeBindings: Record<string, string> = {}
  for (const entity of Object.values(entities)) {
    const identity = nativeIdentity(entity)
    if (identity) modeBindings[`${identity.mode}:${identity.database}:${identity.databaseId}`] = entity.id
  }
  for (const entity of Object.values(entities)) {
    const identity = nativeIdentity(entity)
    const record = nativeSourceRecord(entity)
    if (entity.kind !== 'class' || !identity || !Array.isArray(record?.PassiveIDs)) continue
    const passives = Object.fromEntries(record.PassiveIDs.filter((id): id is number => typeof id === 'number').flatMap(id => {
      // A base fallback must not override a mode replacement, or class innate links use the wrong rules
      const target = modeBindings[`${identity.mode}:passive:${id}`] ?? modeBindings[`base:passive:${id}`]
      return target ? [[String(id), target]] : []
    }))
    entities[entity.id] = { ...entity, legacy: { ...(nativeRecord(entity.legacy) ? entity.legacy : {}), passiveEntityIds: passives } }
  }
  return { ...base, entities: Object.fromEntries(Object.entries(entities).map(([id, entity]) => [id, sourcedEntity(entity)])), claims: base.claims.filter(claim => entities[claim.entityId]), legacy: { ...(nativeRecord(base.legacy) ? base.legacy : {}), nativeModeIdentityBindings: modeBindings } }
}
