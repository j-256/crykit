import { jsonRecord } from './crystal-edit'
import { CRYSTAL_EDIT_CATALOG_SCHEMA, modCatalogTitle } from './mod-layers'
import type { CatalogId, CatalogRevisionId, CatalogSnapshot, JsonValue, ModCatalogPin } from './types'
import { steamWorkshopFileId } from './mod-workshop'
import { normalizeModName } from './mods'
import { isModSearchPreview } from './mod-search'

export const MAX_MOD_SOURCE_BYTES = 96 * 1024 * 1024
export const MAX_MOD_SOURCE_NODES = 3_000_000

export interface ModRevision extends ModCatalogPin {
  readonly title: string
  readonly declaredVersion?: string
  readonly editorVersion?: number
  readonly sourceDigest: string
  readonly steamWorkshopFileId?: string
  readonly rules?: Readonly<Record<string, JsonValue>>
  readonly catalog: CatalogSnapshot
}

export interface Mod {
  readonly id: CatalogId
  readonly title: string
  readonly revisions: readonly ModRevision[]
}

export interface BundledLibraryMod {
  readonly id: CatalogId
  readonly key: string
  readonly title: string
  readonly declaredVersion?: string
  readonly editorVersion: number
  readonly sourceDigest: string
  readonly steamWorkshopFileId?: string
  readonly models: Readonly<Record<string, readonly number[]>>
  readonly catalogNames?: readonly string[]
  readonly sourceRecordField?: string
  readonly nativeBaseReplacements?: boolean
}

export interface LibraryMod extends Mod {
  readonly bundled: readonly BundledLibraryMod[]
}

export function bundledModDefinitionCount(mod: BundledLibraryMod): number {
  return Object.values(mod.models).reduce((sum, records) => sum + records.length, 0)
}

export const MOD_PROJECT_FIELD = 'Source mod project ID'

export interface ModCatalogEntry {
  readonly key: string
  readonly name?: string
  readonly projectId?: CatalogId
  readonly projectRevisionId?: CatalogRevisionId
  readonly sourceIds: readonly string[]
}

export interface ModLibraryCard {
  readonly id: string
  readonly title: string
  readonly project?: LibraryMod
  readonly catalogNames: readonly string[]
  readonly sourceIds: readonly string[]
  readonly entryCount: number
}

export function modCardIncludesEntry(card: ModLibraryCard, entry: ModCatalogEntry): boolean {
  if (entry.projectId) return entry.projectId === card.project?.id && (!entry.projectRevisionId || entry.projectRevisionId === card.project?.revisions[0]?.catalogRevisionId)
  if (entry.sourceIds.some(id => card.sourceIds.includes(id))) return true
  return Boolean(entry.name && card.catalogNames.some(name => normalizeModName(name) === normalizeModName(entry.name!)))
}

export function modLibraryCards(projects: readonly LibraryMod[], names: readonly string[], entries: readonly ModCatalogEntry[]): readonly ModLibraryCard[] {
  let cards: ModLibraryCard[] = projects.map(project => ({ id: project.id, title: project.title, project, catalogNames: [...new Set(project.bundled.flatMap(source => source.catalogNames ?? []))], sourceIds: [...new Set(project.revisions.slice(0, 1).flatMap(revision => Object.values(revision.catalog.entities).flatMap(entity => entity.sources.map(source => source.sourceId))))], entryCount: 0 }))
  const owners = new Map<string, ModLibraryCard[]>()
  for (const card of cards) for (const name of card.catalogNames) {
    const key = normalizeModName(name)
    const matches = owners.get(key) ?? []
    if (!matches.some(match => match.id === card.id)) matches.push(card)
    owners.set(key, matches)
  }
  cards = cards.map(card => ({ ...card, catalogNames: card.catalogNames.filter(name => owners.get(normalizeModName(name))?.length === 1) }))
  const projectSourceIds = new Set(projects.flatMap(project => project.revisions.flatMap(revision => Object.values(revision.catalog.entities).flatMap(entity => entity.sources.map(source => source.sourceId)))))
  const recordedNames = new Map([...names, ...entries.filter(entry => !entry.projectId && !entry.sourceIds.some(id => projectSourceIds.has(id))).flatMap(entry => entry.name ? [entry.name] : [])].filter(name => name.trim() && normalizeModName(name) !== 'base game').map(name => [normalizeModName(name), name]))
  for (const [key, title] of recordedNames) if (owners.get(key)?.length !== 1) cards.push({ id: `name:${key}`, title, catalogNames: [title], sourceIds: [], entryCount: 0 })
  return cards.map(card => ({ ...card, entryCount: new Set(entries.filter(entry => modCardIncludesEntry(card, entry)).map(entry => entry.key)).size })).sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id))
}

export function modRevision(catalog: CatalogSnapshot): ModRevision | undefined {
  if (catalog.schemaVersion !== CRYSTAL_EDIT_CATALOG_SCHEMA || isModSearchPreview(catalog)) return undefined
  const metadata = jsonRecord(catalog.legacy) ? catalog.legacy : {}
  return { catalogId: catalog.id, catalogRevisionId: catalog.revisionId, title: modCatalogTitle(catalog), declaredVersion: typeof metadata.projectVersion === 'string' ? metadata.projectVersion : undefined, editorVersion: typeof metadata.editorVersion === 'number' ? metadata.editorVersion : undefined, sourceDigest: catalog.checksum, steamWorkshopFileId: steamWorkshopFileId(metadata.steamWorkshopFileId), rules: jsonRecord(metadata.gameRules) ? metadata.gameRules : undefined, catalog }
}

export function modLibrary(catalogs: readonly CatalogSnapshot[]): readonly Mod[] {
  const projects = new Map<CatalogId, ModRevision[]>()
  for (const catalog of catalogs) {
    const revision = modRevision(catalog)
    if (revision) projects.set(catalog.id, [...projects.get(catalog.id) ?? [], revision])
  }
  return [...projects.entries()].map(([id, values]) => {
    const revisions = values.sort((left, right) => right.catalog.importedAt.localeCompare(left.catalog.importedAt) || left.catalogRevisionId.localeCompare(right.catalogRevisionId))
    return { id, title: revisions[0]!.title, revisions }
  }).sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id))
}

export function completeModLibrary(catalogs: readonly CatalogSnapshot[], bundled: readonly BundledLibraryMod[]): readonly LibraryMod[] {
  const mods = new Map<CatalogId, LibraryMod>()
  for (const mod of bundled) {
    const original = mods.get(mod.id)
    mods.set(mod.id, { id: mod.id, title: original?.title ?? mod.title, revisions: [], bundled: [...original?.bundled ?? [], mod] })
  }
  for (const mod of modLibrary(catalogs)) {
    const original = mods.get(mod.id)
    mods.set(mod.id, { ...mod, bundled: original?.bundled ?? [] })
  }
  return [...mods.values()].sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id))
}
