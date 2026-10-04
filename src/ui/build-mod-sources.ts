import type { BundledLibraryMod, LibraryMod } from '../domain/mod-library'
import type { CatalogSnapshot } from '../domain/types'

export const BUNDLED_VERSION_PREFIX = 'bundled:'

export function buildModVersions(project: LibraryMod) {
  return [...project.revisions.map(revision => ({ id: revision.catalogRevisionId as string, label: `${revision.declaredVersion ?? 'Version unspecified'} · saved · format ${revision.editorVersion ?? 'unknown'}`, version: revision.declaredVersion, editorVersion: revision.editorVersion })), ...project.bundled.filter(source => !project.revisions.some(revision => revision.sourceDigest === source.sourceDigest)).map(source => ({ id: `${BUNDLED_VERSION_PREFIX}${source.sourceDigest}`, label: `${source.declaredVersion ?? 'Version unspecified'} · bundled · format ${source.editorVersion}`, version: source.declaredVersion, editorVersion: source.editorVersion }))]
}

export async function loadBuildModVersion(project: LibraryMod, selected: string, loadBundled?: (source: BundledLibraryMod) => Promise<CatalogSnapshot>): Promise<CatalogSnapshot> {
  if (selected.startsWith(BUNDLED_VERSION_PREFIX)) {
    const source = project.bundled.find(mod => `${BUNDLED_VERSION_PREFIX}${mod.sourceDigest}` === selected)
    if (!source || !loadBundled) throw new Error('This source cannot be loaded. Import its JSON through Mods, then choose the saved version.')
    return loadBundled(source)
  }
  const catalog = project.revisions.find(revision => revision.catalogRevisionId === selected)?.catalog
  if (!catalog) throw new Error('The selected mod version is unavailable. Choose another version or import the missing source.')
  return catalog
}
