import { DEFAULT_CATALOG } from '../catalog/bundled'
import { BUNDLED_MOD_LIBRARY } from '../catalog/mod-library-metadata'
import { definitionModAvailability } from '../catalog/mods'
import { bundledModIdentity } from './bundled-mods'
import type { BuildBehavior } from './build-behavior'
import { entityDefinitionKey } from './core'
import { definitionLineageRootRef } from './definitions'
import { catalogEntity } from './entity-identities'
import { bundledModReplacementLinks, composeModLayers, CRYSTAL_EDIT_CATALOG_SCHEMA, MOD_CATALOG_SCHEMA, MOD_COMPOSITION_VERSION, modModelRecords, nativeModReplacementLinks } from './mod-layers'
import { MOD_PROJECT_FIELD } from './mod-library'
import { normalizeModName, recordedModNames, updateModSelections, type ModState } from './mods'
import type { BuildRevisionContent, CatalogId, CatalogSnapshot, EntityId, EntityRef, GameSetupRevision, LocalData } from './types'

export interface BuildModRequirement {
  readonly name: string
  readonly projectId?: CatalogId
  readonly state: ModState
  readonly selections: readonly string[]
}

export function buildModReferences(content: BuildRevisionContent): readonly EntityRef[] {
  return [content.primaryClass, content.secondaryClass, ...Object.values(content.equipment).map(selection => selection?.ref), ...content.passives.map(selection => selection.ref), ...content.calculation?.growth.map(row => row.classRef) ?? [], ...content.calculation?.statuses ?? [], content.calculation?.ability].filter((ref): ref is EntityRef => Boolean(ref))
}

export function buildModRequirements(content: BuildRevisionContent, localData: LocalData, catalogs: readonly CatalogSnapshot[], setup?: GameSetupRevision): readonly BuildModRequirement[] {
  const seen = new Set<string>()
  const requirements = new Map<string, BuildModRequirement>()
  for (const ref of buildModReferences(content)) {
    if (seen.has(entityDefinitionKey(ref))) continue
    seen.add(entityDefinitionKey(ref))
    const root = definitionLineageRootRef(localData, ref)
    const catalog = root.kind === 'catalog' ? catalogs.find(candidate => candidate.id === root.catalogId && candidate.revisionId === root.catalogRevisionId) : undefined
    const record = ref.kind === 'personal' ? localData.personalDefinitions[ref.definitionId] : catalog ? catalogEntity(catalog, ref.entityId) : undefined
    const availability = definitionModAvailability(localData, ref, setup, catalogs)
    if (!record || !availability.requiredMod) continue
    const project = record.fields[MOD_PROJECT_FIELD]
    const bundled = bundledModIdentity(record)
    const matches = BUNDLED_MOD_LIBRARY.filter(mod => bundled ? mod.key === bundled.key : mod.catalogNames?.some(name => normalizeModName(name) === normalizeModName(availability.requiredMod!)))
    const source = new Set(matches.map(mod => mod.id)).size === 1 ? matches[0] : undefined
    const origin = catalog?.schemaVersion === MOD_CATALOG_SCHEMA ? catalogs.find(candidate => candidate.schemaVersion === CRYSTAL_EDIT_CATALOG_SCHEMA && setup?.modComposition?.layers.some(layer => layer.enabled && layer.catalogId === candidate.id && layer.catalogRevisionId === candidate.revisionId) && Object.values(candidate.entities).some(entity => entity.sources.some(provenance => record.sources.some(saved => saved.sourceId === provenance.sourceId)))) : undefined
    const projectId = catalog?.schemaVersion === CRYSTAL_EDIT_CATALOG_SCHEMA ? catalog.id : project?.state === 'known' && typeof project.value === 'string' ? project.value as CatalogId : origin?.id ?? source?.id
    const reviewed = BUNDLED_MOD_LIBRARY.find(mod => mod.id === projectId)
    const key = projectId ?? `name:${normalizeModName(availability.requiredMod)}`
    const previous = requirements.get(key)
    requirements.set(key, { name: previous?.name ?? reviewed?.catalogNames?.[0] ?? availability.requiredMod, projectId, state: previous && previous.state !== availability.state ? 'conflicting' : availability.state, selections: [...new Set([...previous?.selections ?? [], record.name])] })
  }
  return [...requirements.values()]
}

export function recordedProjectModNames(projectId: CatalogId, behavior: Pick<GameSetupRevision, 'mods' | 'disabledMods' | 'customMods'>): readonly string[] {
  const source = BUNDLED_MOD_LIBRARY.find(mod => mod.id === projectId)
  const aliases = new Set(source?.catalogNames?.map(normalizeModName))
  return recordedModNames(behavior).filter(name => aliases.has(normalizeModName(name)))
}

export function selectBuildModRevision(behavior: BuildBehavior, catalog: CatalogSnapshot, catalogs: readonly CatalogSnapshot[], enabled = true): BuildBehavior {
  const composition = behavior.modComposition ?? { baseline: { catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId }, layers: [], links: [] }
  const layer = { catalogId: catalog.id, catalogRevisionId: catalog.revisionId, enabled }
  const layers = composition.layers.some(candidate => candidate.catalogId === catalog.id) ? composition.layers.map(candidate => candidate.catalogId === catalog.id ? layer : candidate) : [...composition.layers, layer]
  const allCatalogs = [...catalogs.filter(candidate => candidate.id !== catalog.id || candidate.revisionId !== catalog.revisionId), catalog]
  const availableKeys = new Set(layers.flatMap(pin => {
    const source = allCatalogs.find(candidate => candidate.id === pin.catalogId && candidate.revisionId === pin.catalogRevisionId)
    return source ? [...modModelRecords(source).keys()] : []
  }))
  const previous = composition.layers.find(layer => layer.catalogId === catalog.id)
  const previousCatalog = previous && catalogs.find(candidate => candidate.id === previous.catalogId && candidate.revisionId === previous.catalogRevisionId)
  const previousKeys = new Set(previousCatalog ? modModelRecords(previousCatalog).keys() : [])
  const links = composition.links.filter(link => !previousKeys.has(link.modelKey) || availableKeys.has(link.modelKey))
  const baseline = allCatalogs.find(candidate => candidate.id === composition.baseline.catalogId && candidate.revisionId === composition.baseline.catalogRevisionId)
  if (baseline) for (const link of [...bundledModReplacementLinks(baseline, catalog, BUNDLED_MOD_LIBRARY), ...nativeModReplacementLinks(baseline, catalog)]) {
    if (!links.some(previous => previous.modelKey === link.modelKey || previous.targetEntityId === link.targetEntityId)) links.push(link)
  }
  const choices = recordedProjectModNames(catalog.id, behavior).map(name => ({ name, state: enabled ? 'enabled' as const : 'disabled' as const }))
  return { ...behavior, ...updateModSelections(behavior, choices), modComposition: { ...composition, version: MOD_COMPOSITION_VERSION, layers, links } }
}

export function buildContentForModSetup<Content extends BuildRevisionContent>(content: Content, setup: BuildBehavior, catalogs: readonly CatalogSnapshot[], previousSetup?: BuildBehavior): Content {
  const composition = setup.modComposition
  if (!composition) {
    const rebind = (ref: EntityRef | null): EntityRef | null => {
      if (!ref || ref.kind === 'personal') return ref
      const source = catalogs.find(catalog => catalog.id === ref.catalogId && catalog.revisionId === ref.catalogRevisionId)
      const pin = setup.catalogLock[ref.catalogId]
      const target = catalogs.find(catalog => catalog.id === ref.catalogId && catalog.revisionId === pin)
      return source?.schemaVersion === MOD_CATALOG_SCHEMA && target && catalogEntity(target, ref.entityId) ? { ...ref, catalogRevisionId: target.revisionId } : ref
    }
    return mapBuildModReferences(content, rebind)
  }
  const pin = setup.catalogLock[composition.baseline.catalogId]
  if (!pin) return content
  let effective: ReturnType<typeof composeModLayers>
  try { effective = composeModLayers(composition, catalogs) } catch { return content }
  const rebind = (ref: EntityRef | null): EntityRef | null => {
    if (!ref || ref.kind === 'personal') return ref
    const source = catalogs.find(catalog => catalog.id === ref.catalogId && catalog.revisionId === ref.catalogRevisionId)
    let target = ref.entityId
    if (ref.catalogId !== composition.baseline.catalogId) {
      if (!source || !composition.layers.some(layer => layer.enabled && layer.catalogId === source.id)) return ref
      const modelKey = [...modModelRecords(source)].find(([, entity]) => entity.id === ref.entityId)?.[0]
      if (!modelKey || !effective.identities[modelKey]) return ref
      target = effective.identities[modelKey]! as EntityId
    } else if (source?.schemaVersion !== MOD_CATALOG_SCHEMA && ref.catalogRevisionId !== composition.baseline.catalogRevisionId && previousSetup?.catalogLock[ref.catalogId] !== ref.catalogRevisionId) return ref
    return effective.entities[target] ? { kind: 'catalog', catalogId: composition.baseline.catalogId, catalogRevisionId: pin, entityId: target } : ref
  }
  return mapBuildModReferences(content, rebind)
}

function mapBuildModReferences<Content extends BuildRevisionContent>(content: Content, rebind: (ref: EntityRef | null) => EntityRef | null): Content {
  return { ...content, primaryClass: rebind(content.primaryClass), secondaryClass: rebind(content.secondaryClass), equipment: Object.fromEntries(Object.entries(content.equipment).map(([slot, selection]) => [slot, selection ? { ...selection, ref: rebind(selection.ref)! } : selection])), passives: content.passives.map(selection => ({ ...selection, ref: rebind(selection.ref)! })), ...(content.calculation ? { calculation: { ...content.calculation, growth: content.calculation.growth.map(row => ({ ...row, classRef: rebind(row.classRef) })), statuses: content.calculation.statuses.map(ref => rebind(ref)!), ...(content.calculation.ability ? { ability: rebind(content.calculation.ability) } : {}) } } : {}) }
}
