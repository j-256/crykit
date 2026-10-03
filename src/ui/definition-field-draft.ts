import { sameValue } from '../domain/definition-values'
import type { CatalogEntity, JsonValue, Knowledge, SourceRef } from '../domain/types'
import { parseBoundedJson } from '../interchange/json'

export interface DefinitionFieldDraft {
  readonly mode: 'keep' | 'known' | 'unknown' | 'notApplicable' | 'hide' | 'conflicting'
  readonly type: 'text' | 'number' | 'boolean' | 'list' | 'json'
  readonly text: string
  readonly reason: string
  readonly preserved?: Knowledge<JsonValue>
  readonly selectedSources?: readonly SourceRef[]
}

export function fieldDraft(value: Knowledge<JsonValue> | null | undefined, edited = false): DefinitionFieldDraft {
  const known = value?.state === 'known' ? value.value : undefined
  const type = typeof known === 'number' ? 'number' : typeof known === 'boolean' ? 'boolean' : Array.isArray(known) && known.every(entry => typeof entry === 'string') ? 'list' : known !== undefined && typeof known !== 'string' ? 'json' : 'text'
  return {
    mode: edited ? value === null ? 'hide' : value?.state ?? 'unknown' : 'keep', type,
    text: known === undefined ? '' : type === 'list' ? (known as readonly string[]).join('\n') : type === 'json' ? JSON.stringify(known, null, 2) : String(known),
    reason: value && 'reason' in value ? value.reason ?? '' : '',
    ...(value ? { preserved: value } : {}),
  }
}

export function draftFieldValue(draft: DefinitionFieldDraft): Knowledge<JsonValue> | null | undefined {
  if (draft.mode === 'keep') return undefined
  if (draft.mode === 'hide') return null
  if (draft.mode === 'conflicting') return draft.preserved
  if (draft.mode === 'unknown' || draft.mode === 'notApplicable') return { state: draft.mode, ...(draft.reason.trim() ? { reason: draft.reason.trim() } : {}) }
  let value: JsonValue = draft.text
  if (draft.type === 'number') {
    if (!draft.text.trim() || !Number.isFinite(Number(draft.text))) throw new Error('Enter a finite number, or choose Unknown.')
    value = Number(draft.text)
  } else if (draft.type === 'boolean') {
    if (draft.text !== 'true' && draft.text !== 'false') throw new Error('Choose Yes or No, or mark the fact Unknown.')
    value = draft.text === 'true'
  } else if (draft.type === 'list') value = draft.text.split('\n').map(entry => entry.trim()).filter(Boolean)
  else if (draft.type === 'json') value = parseBoundedJson(new TextEncoder().encode(draft.text), 'Structured fact')
  const sources = draft.preserved?.state === 'known' && sameValue(draft.preserved.value, value) ? draft.preserved.sources : draft.preserved?.state === 'conflicting' ? draft.preserved.claims.find(claim => sameValue(claim.value, value) && sameValue(claim.sources, draft.selectedSources))?.sources : undefined
  return { state: 'known', value, ...(sources ? { sources } : {}) }
}

export function definitionDraftFields(entity: Pick<CatalogEntity, 'fields'>): Readonly<Record<string, DefinitionFieldDraft>> {
  return Object.fromEntries(Object.entries(entity.fields).map(([name, value]) => [name, fieldDraft(value)]))
}
