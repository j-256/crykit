import { AppDataError } from '../interchange/errors'

const MAX_CAUSE_DEPTH = 4
const URL_LIFETIME_MS = 30_000

// Account entry needs these helpers without initializing planner catalogs through the UI model
function hasQuotaExceededCause(reason: unknown, depth = 0): boolean {
  if (depth > MAX_CAUSE_DEPTH || !reason || typeof reason !== 'object') return false
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

export function downloadBytes(bytes: Uint8Array, filename: string, mediaType = 'application/octet-stream') {
  const blob = new Blob([bytes as BlobPart], { type: mediaType })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), URL_LIFETIME_MS)
}
