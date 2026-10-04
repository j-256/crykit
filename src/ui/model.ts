import { definitionModAvailability } from '../catalog/mods'
import type { CatalogSnapshot, EntityRef, Knowledge, LocalData, Quantity, GameSetupRevision } from '../domain/types'
import { AppDataError } from '../interchange/errors'
import { catalogEntity } from '../domain/entity-identities'
import { CRYSTAL_EDIT_VERSION_FIELD } from '../domain/crystal-edit-compatibility'
import { jsonRecord } from '../domain/crystal-edit'
import { BUNDLED_MOD_LIBRARY } from '../catalog/mod-library-metadata'
import { modCatalogForPin, modCatalogTitle } from '../domain/mod-layers'
import { normalizeModName } from '../domain/mods'

const MOD_SUMMARY_NAME_LIMIT = 2

export function ownRecordValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined
}

export function catalogLocksMatch(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>) {
  const leftEntries = Object.entries(left).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
  const rightEntries = Object.entries(right).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries)
}

function hasQuotaExceededCause(reason: unknown, depth = 0): boolean {
  if (depth > 4 || !reason || typeof reason !== 'object') return false
  if (typeof DOMException !== 'undefined' && reason instanceof DOMException && reason.name === 'QuotaExceededError') return true
  if (reason instanceof Error && reason.name === 'QuotaExceededError') return true
  return 'cause' in reason && hasQuotaExceededCause(reason.cause, depth + 1)
}

export function formatAppError(reason: unknown, fallback: string) {
  const quotaAction = hasQuotaExceededCause(reason) ? ' Browser storage is full. Export a recovery backup, free space for this site in browser settings, then retry.' : ''
  if (reason instanceof AppDataError) return `${reason.userMessage}.${quotaAction} Error code ${reason.code}; diagnostic ${reason.diagnosticId}.`
  if (quotaAction) return `${fallback}${quotaAction}`
  return reason instanceof Error ? reason.message : fallback
}

export function resolveEntity(localData: LocalData, catalogs: readonly CatalogSnapshot[], ref: EntityRef | null | undefined) {
  if (!ref) return undefined
  if (ref.kind === 'personal') return ownRecordValue(localData.personalDefinitions, ref.definitionId)
  const snapshot = catalogs.find((catalog) => catalog.id === ref.catalogId && catalog.revisionId === ref.catalogRevisionId)
  const entity = snapshot ? catalogEntity(snapshot, ref.entityId) : undefined
  const version = snapshot && jsonRecord(snapshot.legacy) ? snapshot.legacy.editorVersion : undefined
  return entity && typeof version === 'number' && !entity.fields[CRYSTAL_EDIT_VERSION_FIELD] ? { ...entity, fields: { ...entity.fields, [CRYSTAL_EDIT_VERSION_FIELD]: { state: 'known' as const, value: version, sources: entity.sources } } } : entity
}

export function resolveCalculationEntity(localData: LocalData, catalogs: readonly CatalogSnapshot[], ref: EntityRef, gameSetup?: GameSetupRevision) {
  const definition = resolveEntity(localData, catalogs, ref)
  return definition ? { ...definition, modAvailability: definitionModAvailability(localData, ref, gameSetup, catalogs) } : undefined
}

export function entityName(localData: LocalData, catalogs: readonly CatalogSnapshot[], ref: EntityRef | null | undefined, fallback = 'Unresolved entry') {
  return resolveEntity(localData, catalogs, ref)?.name ?? fallback
}

export function quantityLabel(quantity: Quantity) {
  if (quantity.kind === 'unknown') return 'Quantity unknown'
  if (quantity.kind === 'atLeast') return `At least ${quantity.value}`
  return `${quantity.value}`
}

export function knowledgeLabel<T>(knowledge: Knowledge<T>, format: (value: T) => string = String) {
  if (knowledge.state === 'known') return format(knowledge.value)
  if (knowledge.state === 'conflicting') return 'Conflicting claims'
  if (knowledge.state === 'notApplicable') return 'Not applicable'
  return 'Unknown'
}

export function knowledgeTone<T>(knowledge: Knowledge<T>) {
  if (knowledge.state === 'known') return 'positive' as const
  if (knowledge.state === 'conflicting') return 'danger' as const
  return 'warning' as const
}

export function gameSetupModSummary(setup: Pick<GameSetupRevision, 'mods' | 'modComposition'>, catalogs: readonly CatalogSnapshot[] = []): string {
  const layers = setup.modComposition?.layers.filter(layer => layer.enabled) ?? []
  const aliases = new Set(layers.flatMap(layer => BUNDLED_MOD_LIBRARY.find(project => project.id === layer.catalogId)?.catalogNames?.map(normalizeModName) ?? []))
  const titles = layers.map(layer => {
    const catalog = modCatalogForPin(catalogs, layer)
    const project = BUNDLED_MOD_LIBRARY.find(project => project.id === layer.catalogId)
    return catalog ? modCatalogTitle(catalog) : project ? `${project.title} (source unavailable)` : 'Unavailable mod source'
  })
  const named = setup.mods.state === 'known' ? setup.mods.value.filter(name => !aliases.has(normalizeModName(name))) : []
  const compact = (names: readonly string[]) => `${names.slice(0, MOD_SUMMARY_NAME_LIMIT).join(', ')}${names.length > MOD_SUMMARY_NAME_LIMIT ? ` + ${names.length - MOD_SUMMARY_NAME_LIMIT} more` : ''}`
  const parts = [...(titles.length ? [`Enabled: ${compact(titles)}`] : []), ...(named.length ? [`Named only: ${compact(named)}`] : [])]
  return parts.join(' · ') || (setup.mods.state === 'known' ? 'No mods selected' : 'Mods unresolved')
}

export function activeGameSetup(localData: LocalData): GameSetupRevision | undefined {
  return localData.planningGameSetupRevisionId ? ownRecordValue(localData.gameSetups, localData.planningGameSetupRevisionId) : undefined
}

export function formatRelativeDate(value: string | undefined) {
  if (!value) return 'Observation date unknown'
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value)
  const date = dateOnly ? new Date(`${value}T00:00:00`) : new Date(value)
  if (Number.isNaN(date.valueOf())) return value
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date)
}

export function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || '?'
}

export function downloadBytes(bytes: Uint8Array, filename: string, mediaType = 'application/octet-stream') {
  const blob = new Blob([bytes as BlobPart], { type: mediaType })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
