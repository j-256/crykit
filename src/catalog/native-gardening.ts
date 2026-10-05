import facts from './native-gardening.json' with { type: 'json' }
import { bundledCatalogForSnapshot } from './bundled'
import { projectSourceSemantics } from './source-semantics'
import { sameValue } from '../domain/definition-values'
import { nativeIdentity, nativeRecord, nativeSourceRecord } from '../domain/native-game'
import type { CatalogEntity, CatalogRef, CatalogSnapshot } from '../domain/types'

export interface NativeGardening {
  readonly minutes: number
  readonly wateringReductionMinutes: number
  readonly encounters: readonly { readonly name: string; readonly ref: CatalogRef }[]
  readonly evidence: readonly string[]
}

export function nativeGardening(catalog: CatalogSnapshot, entity: CatalogEntity): NativeGardening | undefined {
  const identity = nativeIdentity(entity)
  const snapshot = bundledCatalogForSnapshot(catalog)
  const baseline = snapshot?.entities[entity.id]
  const metadata = nativeRecord(catalog.legacy) ? catalog.legacy : {}
  const source = nativeRecord(metadata.nativeSource) ? metadata.nativeSource : {}
  const executable = nativeRecord(source.executable) ? source.executable : {}
  if (!snapshot || metadata.sourceContentDigest !== facts.nativeContentDigest || executable.sha256 !== facts.gameExecutableSha256 || identity?.mode !== 'base' || identity.database !== 'item' || !baseline || !sameValue(entity, baseline) && !sameValue(entity, projectSourceSemantics(baseline))) return undefined
  const seed = facts.seeds.find(entry => entry.itemID === identity.databaseId)
  if (!seed) return undefined
  const troop = Object.values(catalog.entities).find(entry => { const native = nativeIdentity(entry); return native?.mode === 'base' && native.database === 'troop' && native.databaseId === seed.troopID })
  const record = troop && nativeSourceRecord(troop)
  const baselineTroop = troop && snapshot?.entities[troop.id]
  if (!troop || !baselineTroop || !sameValue(troop, baselineTroop) || !Array.isArray(record?.Members)) return undefined
  const encounters = record.Members.filter(nativeRecord).flatMap(member => {
    const monster = Object.values(catalog.entities).find(entry => { const native = nativeIdentity(entry); return native?.mode === 'base' && native.database === 'monster' && native.databaseId === member.MonsterID })
    const originalMonster = monster && snapshot?.entities[monster.id]
    return monster && originalMonster && sameValue(monster, originalMonster) && member.BeginBattleDead === false ? [{ name: monster.name, ref: { kind: 'catalog' as const, catalogId: catalog.id, catalogRevisionId: catalog.revisionId, entityId: monster.id } }] : []
  })
  if (encounters.length !== record.Members.length) return undefined
  return { minutes: seed.minutes, wateringReductionMinutes: Math.trunc(seed.minutes / 2), encounters, evidence: ['Sang.PartyData.CQuest.SEED_TYPE_ITEMS/SEED_TYPE_TROOP_IDS/SEED_TYPE_SPROUT_MINUTES', 'Sang.PartyData.CQuest.PlantSeed/WaterSeed/GetPluckedSeedTroop', `Database/troop.dat; ID ${seed.troopID}`, 'Sang.Field.EntityAction.EntityAction: Garden Pluck starts the seed troop with loot enabled'] }
}
