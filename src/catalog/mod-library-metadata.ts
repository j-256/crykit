import sources from './bundled-mod-sources.json' with { type: 'json' }
import moonlight from './moonlight-project-v2.2.json' with { type: 'json' }
import equipment from './equipment-expansion.json' with { type: 'json' }
import innates from './learnable-innates.json' with { type: 'json' }
import type { BundledLibraryMod } from '../domain/mod-library'
import type { CatalogId } from '../domain/types'

const DEFINITION_KEYS: Readonly<Record<string, string>> = { [moonlight.source.projectId]: 'moonlight-project', [equipment.source.projectId]: 'equipment-expansion', [innates.source.projectId]: 'learnable-innates' }
const CATALOG_NAMES: Readonly<Record<string, readonly string[]>> = { [moonlight.source.projectId]: [moonlight.requiredMod], [innates.source.projectId]: ['Learnable Innate Skill'] }

export const BUNDLED_MOD_LIBRARY: readonly BundledLibraryMod[] = sources.mods.map(source => ({
  id: `crystal-edit:${source.projectId}` as CatalogId, key: DEFINITION_KEYS[source.projectId] ?? source.projectId, title: source.title, declaredVersion: source.version, editorVersion: source.editorVersion, sourceDigest: `sha256:${source.sha256}`, steamWorkshopFileId: source.steamWorkshopFileId, models: source.models, catalogNames: [...CATALOG_NAMES[source.projectId] ?? [], source.title],
  ...(source.projectId === innates.source.projectId ? { sourceRecordField: 'Learnable Innate Skill v1.0 source record', nativeBaseReplacements: true } : {}),
}))
