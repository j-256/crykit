import type { CatalogSnapshot, EntityRef, Knowledge, Profile, Quantity, RulesetRevision } from '../domain/types'
import { AppDataError } from '../interchange/errors'

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

export function resolveEntity(profile: Profile, catalogs: readonly CatalogSnapshot[], ref: EntityRef | null | undefined) {
  if (!ref) return undefined
  if (ref.kind === 'personal') return profile.personalDefinitions[ref.definitionId]
  const snapshot = catalogs.find((catalog) => catalog.id === ref.catalogId && catalog.revisionId === ref.catalogRevisionId)
  return snapshot?.entities[ref.entityId]
}

export function entityName(profile: Profile, catalogs: readonly CatalogSnapshot[], ref: EntityRef | null | undefined, fallback = 'Unresolved entry') {
  return resolveEntity(profile, catalogs, ref)?.name ?? fallback
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

export function activeRuleset(profile: Profile): RulesetRevision | undefined {
  return profile.activeRulesetRevisionId ? profile.rulesets[profile.activeRulesetRevisionId] : undefined
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
