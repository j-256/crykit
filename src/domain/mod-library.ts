import { jsonRecord } from './crystal-edit'
import { CRYSTAL_EDIT_CATALOG_SCHEMA, modCatalogTitle } from './mod-layers'
import type { CatalogId, CatalogSnapshot, JsonValue, ModCatalogPin } from './types'

export interface ModRevision extends ModCatalogPin {
  readonly title: string
  readonly declaredVersion?: string
  readonly editorVersion?: number
  readonly sourceDigest: string
  readonly rules?: Readonly<Record<string, JsonValue>>
  readonly catalog: CatalogSnapshot
}

export interface Mod {
  readonly id: CatalogId
  readonly title: string
  readonly revisions: readonly ModRevision[]
}

export function modRevision(catalog: CatalogSnapshot): ModRevision | undefined {
  if (catalog.schemaVersion !== CRYSTAL_EDIT_CATALOG_SCHEMA) return undefined
  const metadata = jsonRecord(catalog.legacy) ? catalog.legacy : {}
  return { catalogId: catalog.id, catalogRevisionId: catalog.revisionId, title: modCatalogTitle(catalog), declaredVersion: typeof metadata.projectVersion === 'string' ? metadata.projectVersion : undefined, editorVersion: typeof metadata.editorVersion === 'number' ? metadata.editorVersion : undefined, sourceDigest: catalog.checksum, rules: jsonRecord(metadata.gameRules) ? metadata.gameRules : undefined, catalog }
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
