import { asId, assertExpectedRevision, nowTimestamp, updateLocalData } from './core'
import type { ModLibraryCard } from './mod-library'
import type { CatalogId, LocalData, ReferenceLibrarySettings, Timestamp } from './types'

export const REFERENCE_LIBRARY_SETTINGS_VERSION = 1

export function referenceLibraryWithMod(settings: ReferenceLibrarySettings | undefined, modId: string, included: boolean): ReferenceLibrarySettings {
  asId<CatalogId>(modId)
  const excluded = new Set(settings?.excludedMods ?? [])
  if (included) excluded.delete(modId)
  else excluded.add(modId)
  return { version: REFERENCE_LIBRARY_SETTINGS_VERSION, excludedMods: [...excluded] }
}

export function modIsInReference(data: LocalData, card: ModLibraryCard): boolean {
  return card.entryCount > 0 && !data.referenceLibrary?.excludedMods.includes(card.id)
}

export function setModInReference(data: LocalData, modId: string, included: boolean, expectedRevision?: number, at: Timestamp = nowTimestamp()): LocalData {
  assertExpectedRevision(data, expectedRevision)
  const settings = referenceLibraryWithMod(data.referenceLibrary, modId, included)
  if (JSON.stringify(settings.excludedMods) === JSON.stringify(data.referenceLibrary?.excludedMods ?? [])) return data
  return updateLocalData(data, { referenceLibrary: settings }, 'reference.mod-membership', ['referenceLibrary'], at)
}
