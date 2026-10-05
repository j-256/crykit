import receipt from './certainty-catalog.json' with { type: 'json' }
import moonlight from './moonlight-project-v2.2.json' with { type: 'json' }
import modLinks from './moonlight-project-links-v1.json' with { type: 'json' }
import { projectSourceCatalog, reconcileNativeSourceIdentities } from './source-catalog'
import { bundledModEntityId, buildBundledModEntities, type BundledModSnapshot } from '../domain/bundled-mods'
import { nativeRecord } from '../domain/native-game'
import type { CatalogRevisionId, CatalogSnapshot, JsonValue } from '../domain/types'
import { NATIVE_GAME_DATA } from './native-game'
import supplementalIds from './supplemental-entity-ids.json' with { type: 'json' }
import { compileCatalogIdentities } from '../domain/catalog-identities'

export const CERTAINTY_CATALOG_REVISION_ID = 'catalog-v1' as CatalogRevisionId
export const MOONLIGHT_SNAPSHOT = moonlight as unknown as BundledModSnapshot

export function assembleSourceCatalog(base: CatalogSnapshot): CatalogSnapshot {
  const reviewed = reconcileNativeSourceIdentities(base)
  const entities = { ...reviewed.entities }
  if (modLinks.sourceDigest !== MOONLIGHT_SNAPSHOT.source.sha256) throw new Error('Moonlight identity links require their reviewed export')
  const modEntities = { ...buildBundledModEntities(MOONLIGHT_SNAPSHOT, NATIVE_GAME_DATA.enums) }
  const link = (observationId: string, family: string, modelId: number) => {
    const id = bundledModEntityId(MOONLIGHT_SNAPSHOT.key, family, modelId)
    const target = modEntities[id]
    const observation = entities[observationId]
    if (!target || !observation) throw new Error('Moonlight identity evidence has no source or target')
    modEntities[id] = { ...target, aliases: [...new Set([...target.aliases, ...(target.name !== observation.name ? [observation.name] : [])])] }
    delete entities[observationId]
  }
  for (const entry of modLinks.classes) {
    const job = MOONLIGHT_SNAPSHOT.families.Jobs!.find(record => record.ID === entry.modelId)!
    if (job.Name !== entry.name) throw new Error('Moonlight class identity changed')
    link(entry.observationEntityId, 'Jobs', entry.modelId)
    for (const skill of entry.skills) {
      const cell = Array.isArray(job.LearnTree) && Array.isArray(job.LearnTree[skill.column]) ? job.LearnTree[skill.column][skill.row] : undefined
      const record = MOONLIGHT_SNAPSHOT.families[skill.family]?.find(record => record.ID === skill.modelId)
      if (!nativeRecord(cell) || cell.DataID !== skill.modelId || cell.NodeType !== (skill.family === 'Abilities' ? 2 : 3) || record?.Name !== skill.exportedName || entities[skill.observationEntityId]?.name !== skill.observedName) throw new Error('Moonlight observed tree link changed')
      link(skill.observationEntityId, skill.family, skill.modelId)
    }
    for (const id of entry.supersededObservationIds) delete entities[id]
  }
  Object.assign(entities, modEntities)
  const catalog = projectSourceCatalog({ ...reviewed, entities })
  return { ...catalog, revisionId: CERTAINTY_CATALOG_REVISION_ID, checksum: receipt.checksum, applicability: { state: 'known', value: `Windows ${NATIVE_GAME_DATA.source.gameVersion} base definitions and versioned mod exports` }, legacy: { ...(nativeRecord(catalog.legacy) ? catalog.legacy : {}), bundledMods: [{ key: MOONLIGHT_SNAPSHOT.key, source: MOONLIGHT_SNAPSHOT.source as unknown as JsonValue }] } }
}

export function assembleCertaintyCatalog(base: CatalogSnapshot): CatalogSnapshot {
  return compileCatalogIdentities(assembleSourceCatalog(base), supplementalIds.ids)
}
