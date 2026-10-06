import { catalogClassSource } from '../domain/build-mechanics'
import { bundledModEntityId, bundledModIdentity } from '../domain/bundled-mods'
import { calculationModResolver } from '../domain/calculation-mods'
import { CLASS_FIELDS, CRYSTAL_EDIT_FIELDS, jsonRecord } from '../domain/crystal-edit'
import { crystalEditPlanningRecord } from '../domain/crystal-edit-compatibility'
import { logicalEntityKey } from '../domain/definitions'
import { catalogEntity } from '../domain/entity-identities'
import { resolveGameRules } from '../domain/game-rules'
import { modModelEntity } from '../domain/mod-layers'
import { nativeEntityId, nativeIdentity, nativeSourceRecord } from '../domain/native-game'
import { nativeInteger } from '../domain/native-number'
import type { BuildRevisionContent, CatalogEntity, CatalogSnapshot, EntityId, EntityRef, GameSetupRevision, LocalData } from '../domain/types'
import { resolveCalculationEntity } from './model'

export interface PreviewAbilityGroup {
  readonly key: string
  readonly label: string
  readonly refs: readonly EntityRef[]
}

function nativeTarget(catalog: CatalogSnapshot, family: 'ability' | 'job', id: number, mode = 'base'): CatalogEntity | undefined {
  const metadata = jsonRecord(catalog.legacy) ? catalog.legacy : undefined
  const modeBindings = jsonRecord(metadata?.nativeModeIdentityBindings) ? metadata.nativeModeIdentityBindings : {}
  const binding = Object.entries(modeBindings).find(([key]) => key.toLowerCase() === `${mode}:${family}:${id}`.toLowerCase())?.[1]
  const baseBindings = jsonRecord(metadata?.nativeIdentityBindings) ? metadata.nativeIdentityBindings : {}
  const entityId = typeof binding === 'string' ? binding : mode === 'base' && typeof baseBindings[`${family}:${id}`] === 'string' ? baseBindings[`${family}:${id}`] as string : nativeEntityId(family, id, mode)
  return catalogEntity(catalog, entityId)
}

export function previewAbilityGroups(content: BuildRevisionContent, localData: LocalData, catalogs: readonly CatalogSnapshot[], gameSetup?: GameSetupRevision): readonly PreviewAbilityGroup[] {
  const resolve = calculationModResolver(ref => resolveCalculationEntity(localData, catalogs, ref, gameSetup)).resolve
  const mode = resolveGameRules(gameSetup, catalogs).mode ?? content.calculation?.pcMode ?? 'standard'
  const groups: PreviewAbilityGroup[] = []
  const seen = new Set<string>()
  for (const [key, label, classRef] of [['primary', 'Class', content.primaryClass], ['secondary', 'Subclass', content.secondaryClass]] as const) {
    if (!classRef) continue
    const definition = resolve(classRef)
    const source = catalogClassSource(classRef, resolve)
    const catalog = source && catalogs.find(value => value.id === source.ref.catalogId && value.revisionId === source.ref.catalogRevisionId)
    if (definition?.kind !== 'class' || !source || !catalog) continue
    const imported = crystalEditPlanningRecord(definition)
    if (definition.fields['Crystal Edit source record'] && !imported) continue
    const record = imported ?? nativeSourceRecord(definition)
    const field = definition.fields[CLASS_FIELDS.abilities] ?? definition.fields[CRYSTAL_EDIT_FIELDS.abilities]
    if (field && field.state !== 'known') continue
    let ids = field ? field.state === 'known' ? field.value : undefined : record?.AbilityIDs
    const identity = nativeIdentity(source.definition)
    const originalField = source.definition.fields[CLASS_FIELDS.abilities] ?? source.definition.fields[CRYSTAL_EDIT_FIELDS.abilities]
    const inheritedMembership = classRef.kind === 'catalog' || JSON.stringify(field) === JSON.stringify(originalField)
    if (!imported && identity?.database === 'job' && identity.mode === 'base' && inheritedMembership && mode !== 'standard') {
      const variant = nativeTarget(catalog, 'job', identity.databaseId, mode)
      if (variant) ids = nativeSourceRecord(variant)?.AbilityIDs
    }
    if (!Array.isArray(ids) || !ids.every(id => nativeInteger(id) && id >= 0)) continue
    const bundled = 'legacy' in source.definition ? bundledModIdentity(source.definition) : undefined
    const refs: EntityRef[] = []
    for (const id of ids as number[]) {
      const ability = modModelEntity(catalog, `crystal-edit:Abilities:${id}`)
        ?? (bundled ? catalogEntity(catalog, bundledModEntityId(bundled.key, 'Abilities', id)) : undefined)
        ?? (identity || imported ? nativeTarget(catalog, 'ability', id) : undefined)
      if (!ability || !['ability', 'monsterMagic'].includes(ability.kind)) continue
      const ref: EntityRef = { ...source.ref, entityId: ability.id as EntityId }
      const resolved = resolve(ref)
      if (!resolved || !['ability', 'monsterMagic'].includes(resolved.kind)) continue
      const logicalKey = logicalEntityKey(localData, ref)
      if (seen.has(logicalKey)) continue
      seen.add(logicalKey)
      refs.push(ref)
    }
    if (refs.length) groups.push({ key, label: `${label}: ${definition.name}`, refs })
  }
  return groups
}
