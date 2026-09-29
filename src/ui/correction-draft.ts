import { sameCorrectionValue, type CatalogCorrection, type CorrectionChange } from '../domain/corrections'
import type { CatalogEntity, JsonValue, Knowledge, SourceRef } from '../domain/types'
import { parseBoundedJson } from '../interchange/json'

export interface CorrectionFieldDraft {
  readonly mode: 'keep' | 'known' | 'unknown' | 'notApplicable' | 'hide' | 'conflicting'
  readonly type: 'text' | 'number' | 'boolean' | 'list' | 'json'
  readonly text: string
  readonly reason: string
  readonly preserved?: Knowledge<JsonValue>
  readonly selectedSources?: readonly SourceRef[]
}

export function fieldDraft(value: Knowledge<JsonValue> | null | undefined, edited = false): CorrectionFieldDraft {
  const known = value?.state === 'known' ? value.value : undefined
  const type = typeof known === 'number' ? 'number' : typeof known === 'boolean' ? 'boolean' : Array.isArray(known) && known.every(entry => typeof entry === 'string') ? 'list' : known !== undefined && typeof known !== 'string' ? 'json' : 'text'
  return {
    mode: edited ? value === null ? 'hide' : value?.state ?? 'unknown' : 'keep', type,
    text: known === undefined ? '' : type === 'list' ? (known as readonly string[]).join('\n') : type === 'json' ? JSON.stringify(known, null, 2) : String(known),
    reason: value && 'reason' in value ? value.reason ?? '' : '',
    ...(value ? { preserved: value } : {}),
  }
}

export function draftFieldValue(draft: CorrectionFieldDraft): Knowledge<JsonValue> | null | undefined {
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
  const sources = draft.preserved?.state === 'known' && sameCorrectionValue(draft.preserved.value, value) ? draft.preserved.sources : draft.preserved?.state === 'conflicting' ? draft.preserved.claims.find(claim => sameCorrectionValue(claim.value, value) && sameCorrectionValue(claim.sources, draft.selectedSources))?.sources : undefined
  return { state: 'known', value, ...(sources ? { sources } : {}) }
}

export function correctionDraftFields(entity: Pick<CatalogEntity, 'fields'>, correction?: CatalogCorrection): Readonly<Record<string, CorrectionFieldDraft>> {
  const fields = Object.fromEntries(Object.entries(entity.fields).map(([name, value]) => [name, fieldDraft(value)]))
  for (const change of correction?.changes ?? []) if (change.path === 'field') fields[change.field] = fieldDraft(change.after, true)
  const description = correction?.changes.find(change => change.path === 'description')
  const descriptionField = Object.keys(entity.fields).find(field => field.toLocaleLowerCase() === 'description')
  if (description?.path === 'description' && descriptionField) fields[descriptionField] = fieldDraft(description.after === null ? null : { state: 'known', value: description.after }, true)
  return fields
}

export function draftChanges(entity: CatalogEntity, name: string, description: string, aliases: string, hidden: boolean, fields: Readonly<Record<string, CorrectionFieldDraft>>, baselineHidden = false): readonly CorrectionChange[] {
  const changes: CorrectionChange[] = []
  if (!name.trim()) throw new Error('Enter a reference name.')
  if (name.trim() !== entity.name) changes.push({ path: 'name', before: entity.name, after: name.trim() })
  const nextDescription = description.trim() || null
  const descriptionField = Object.keys(entity.fields).find(field => field.toLocaleLowerCase() === 'description')
  if (!descriptionField && nextDescription !== (entity.rawDescription ?? null)) changes.push({ path: 'description', before: entity.rawDescription ?? null, after: nextDescription })
  const nextAliases = [...new Set(aliases.split('\n').map(entry => entry.trim()).filter(Boolean))]
  if (!sameCorrectionValue(nextAliases, entity.aliases)) changes.push({ path: 'aliases', before: entity.aliases, after: nextAliases })
  if (hidden !== baselineHidden) changes.push({ path: 'visibility', before: baselineHidden, after: hidden })
  for (const [field, draft] of Object.entries(fields)) {
    let after: Knowledge<JsonValue> | null | undefined
    try { after = draftFieldValue(draft) } catch (error) { throw new Error(`${field}: ${error instanceof Error ? error.message : 'Invalid value'}`) }
    const before = Object.hasOwn(entity.fields, field) ? entity.fields[field]! : null
    if (after !== undefined && !sameCorrectionValue(before, after)) changes.push({ path: 'field', field, before, after })
  }
  return changes
}
