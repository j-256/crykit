import { definitionLineageRootRef } from '../domain/definitions'
import { modState, normalizeModName, type DefinitionModAvailability } from '../domain/mods'
import type { CatalogId, CatalogSnapshot, EntityRef, LocalData, GameSetupRevision } from '../domain/types'
import { STARTER_CATALOG_ID, STARTER_CATALOG_REVISION_ID } from './starter'
import { bundledModIdentity } from '../domain/bundled-mods'
import { nativeRecord } from '../domain/native-game'
import { catalogEntity } from '../domain/entity-identities'
import { BUNDLED_MOD_LIBRARY } from './mod-library-metadata'
import { MOD_PROJECT_FIELD } from '../domain/mod-library'
import { CRYSTAL_EDIT_CATALOG_SCHEMA, modCatalogTitle } from '../domain/mod-layers'
import { DEFAULT_CATALOG } from './bundled'

export const MOONLIGHT_PROJECT_MOD = 'Moonlight Project'

export const SWITCH_MOD_PACKS = Object.freeze([
  {
    id: 'switch-mod-pack-1',
    name: 'Mod Pack 1: Quality Fun',
    mods: Object.freeze([
      'Appearance Passives',
      'Pointier Hat',
      'Golden Quintar High Jump',
      'Cheap Maps',
      "Cheap Teleport Shards n' Stones",
      'Learnable Innate Skill',
      '1 PP Passives',
      'Unrestricted Weapon Skills',
      'Free Maps',
      'Modern Kids',
    ]),
  },
  {
    id: 'switch-mod-pack-2',
    name: 'Mod Pack 2: New Challenges',
    mods: Object.freeze([
      'Passive Trainer',
      'Doge Shield',
      'Equipment Expansion',
      MOONLIGHT_PROJECT_MOD,
      'Bloodmage',
      'Additional Boss: Yasha Tar',
      'Additional Boss: Pinga',
      'Tempest',
      'Forcemage',
      'Barbarian',
      'Additional Boss: Quintar Husk',
      'Additional Boss: Elder Entities',
    ]),
  },
])

export const CONFIRMED_SWITCH_MOD_SETUP = Object.freeze({
  id: 'switch-confirmed-mod-setup',
  label: 'Switch: confirmed mod setup',
  platform: 'Nintendo Switch',
  gameVersion: '1.6.6',
  enabledMods: Object.freeze([
    'Passive Trainer',
    'Doge Shield',
    'Equipment Expansion',
    MOONLIGHT_PROJECT_MOD,
    'Bloodmage',
    'Additional Boss: Yasha Tar',
    'Additional Boss: Pinga',
    'Tempest',
    'Forcemage',
    'Barbarian',
    'Appearance Passives',
    'Pointier Hat',
    'Golden Quintar High Jump',
    'Cheap Maps',
    'Learnable Innate Skill',
    'Additional Boss: Quintar Husk',
    'Additional Boss: Elder Entities',
    'Free Maps',
  ]),
  disabledMods: Object.freeze([
    "Cheap Teleport Shards n' Stones",
    '1 PP Passives',
    'Unrestricted Weapon Skills',
    'Modern Kids',
  ]),
})

// Associations come from the Equipment Expansion sheet, publisher descriptions, and in-game confirmation
// Exact identities keep unrelated imports and same-name personal definitions unclassified
const REQUIRED_MOD_BY_ENTITY: ReadonlyMap<string, string> = new Map(Object.values(DEFAULT_CATALOG.entities).flatMap(entity => {
  const sourceMod = entity.fields['Source mod']
  const mod = bundledModIdentity(entity)?.requiredMod ?? (sourceMod?.state === 'known' && typeof sourceMod.value === 'string' && normalizeModName(sourceMod.value) !== 'base game' ? sourceMod.value : undefined)
  return mod ? [[entity.id, mod] as const] : []
}))

export type { DefinitionModAvailability } from '../domain/mods'

export function projectModAvailability(projectId: CatalogId, title: string, gameSetup?: GameSetupRevision, revisionId?: string): DefinitionModAvailability {
  const layers = gameSetup?.modComposition?.layers.filter(layer => layer.catalogId === projectId) ?? []
  if (layers.length) {
    const enabled = layers.some(layer => layer.enabled && (!revisionId || layer.catalogRevisionId === revisionId))
    return { requiredMod: title, state: enabled ? 'enabled' : layers.every(layer => !layer.enabled) ? 'disabled' : 'unknown' }
  }
  const names = BUNDLED_MOD_LIBRARY.find(mod => mod.id === projectId)?.catalogNames ?? []
  const states = names.map(name => modState(gameSetup, name))
  const state = states.includes('conflicting') || states.includes('enabled') && states.includes('disabled') ? 'conflicting' : states.includes('enabled') ? 'enabled' : states.includes('disabled') ? 'disabled' : 'unknown'
  return { requiredMod: title, state }
}

export function definitionModAvailability(localData: LocalData, ref: EntityRef, gameSetup?: GameSetupRevision, catalogs: readonly CatalogSnapshot[] = []): DefinitionModAvailability {
  const root = definitionLineageRootRef(localData, ref)
  const catalog = root.kind === 'catalog' ? catalogs.find(value => value.id === root.catalogId && value.revisionId === root.catalogRevisionId) : undefined
  const entity = root.kind === 'catalog' && catalog ? catalogEntity(catalog, root.entityId) : undefined
  if (catalog?.schemaVersion === CRYSTAL_EDIT_CATALOG_SCHEMA) return projectModAvailability(catalog.id, modCatalogTitle(catalog), gameSetup, catalog.revisionId)
  const personal = ref.kind === 'personal' ? localData.personalDefinitions[ref.definitionId] : undefined
  const project = (personal ?? entity)?.fields[MOD_PROJECT_FIELD]
  const sourceMod = (personal ?? entity)?.fields['Source mod']
  const effectiveLayer = entity?.fields['Effective mod layer']
  if (project?.state === 'known' && typeof project.value === 'string') {
    const title = sourceMod?.state === 'known' && typeof sourceMod.value === 'string' ? sourceMod.value : effectiveLayer?.state === 'known' && typeof effectiveLayer.value === 'string' ? effectiveLayer.value : BUNDLED_MOD_LIBRARY.find(mod => mod.id === project.value)?.title ?? 'Source mod'
    return projectModAvailability(project.value as CatalogId, title, gameSetup)
  }
  if (effectiveLayer?.state === 'known' && typeof effectiveLayer.value === 'string') return { requiredMod: effectiveLayer.value, state: gameSetup?.catalogLock[catalog!.id] === catalog!.revisionId ? 'enabled' : 'unknown' }
  const bundledMod = entity && bundledModIdentity(entity)
  if (bundledMod) return { requiredMod: bundledMod.requiredMod, state: modState(gameSetup, bundledMod.requiredMod) }
  const explicitMod = nativeRecord(entity?.legacy) ? entity.legacy.requiredMod : undefined
  if (typeof explicitMod === 'string') return { requiredMod: explicitMod, state: modState(gameSetup, explicitMod) }
  const baselineRevision = gameSetup?.modComposition && root.kind === 'catalog' && root.catalogId === gameSetup.modComposition.baseline.catalogId && root.catalogRevisionId === gameSetup.catalogLock[root.catalogId] ? gameSetup.modComposition.baseline.catalogRevisionId : root.kind === 'catalog' ? root.catalogRevisionId : undefined
  const validCatalog = root.kind === 'catalog' && root.catalogId === STARTER_CATALOG_ID && baselineRevision !== undefined && baselineRevision === STARTER_CATALOG_REVISION_ID
  const requiredMod = validCatalog ? REQUIRED_MOD_BY_ENTITY.get(root.entityId) : undefined
  const namedMod = requiredMod ?? (sourceMod?.state === 'known' && typeof sourceMod.value === 'string' && normalizeModName(sourceMod.value) !== 'base game' ? sourceMod.value : undefined)
  return namedMod ? { state: modState(gameSetup, namedMod), requiredMod: namedMod } : { state: 'unknown' }
}

export function modAvailabilityLabel(availability: DefinitionModAvailability): string | undefined {
  if (!availability.requiredMod) return undefined
  const state = availability.state === 'unknown' ? 'enabled status not recorded' : availability.state === 'conflicting' ? 'enabled status has conflicting records' : availability.state
  return `${availability.requiredMod} mod: ${state}`
}

export function modPlanningReason(availability: DefinitionModAvailability | undefined): string | undefined {
  if (!availability?.requiredMod || availability.state === 'enabled') return undefined
  const reason = availability.state === 'disabled' ? "Mod disabled in this Build's Game Setup" : availability.state === 'conflicting' ? "Conflicting mod settings in this Build's Game Setup" : "Mod status unknown in this Build's Game Setup"
  return `${reason}. You can still select it.`
}
