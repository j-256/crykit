import { entityDefinitionKey } from './core'
import type { CatalogClaim, CatalogEntity, CatalogRef, CatalogSnapshot, JsonValue, Knowledge, PersonalDefinition, SourceRef } from './types'

export const CORRECTIONS_FORMAT = 'crystal-companion-corrections'
export const CORRECTIONS_VERSION = 1
export const MAX_CORRECTIONS = 2_000
export const MAX_CORRECTION_BYTES = 4 * 1024 * 1024

export type CorrectionChange =
  | { readonly path: 'name'; readonly before: string; readonly after: string }
  | { readonly path: 'aliases'; readonly before: readonly string[]; readonly after: readonly string[] }
  | { readonly path: 'description'; readonly before: string | null; readonly after: string | null }
  | { readonly path: 'field'; readonly field: string; readonly before: Knowledge<JsonValue> | null; readonly after: Knowledge<JsonValue> | null }
  | { readonly path: 'visibility'; readonly before: boolean; readonly after: boolean }

export const CORRECTION_DECISIONS = { correction: 'Correct a fact', equivalence: 'Same meaning', refinement: 'Compatible refinement', differentScope: 'Different scope', contradiction: 'Contradictory claims' } as const

export interface CatalogCorrection {
  readonly id: string
  readonly supersedes: readonly string[]
  readonly decision: keyof typeof CORRECTION_DECISIONS
  readonly baselineSources: readonly SourceRef[]
  readonly baselineClaims: readonly CatalogClaim[]
  readonly target: CatalogRef
  readonly baselineChecksum: string
  readonly baselineName: string
  readonly confidence: 'tentative' | 'confirmed'
  readonly reason: string
  readonly evidence: string
  readonly context: { readonly platform: string; readonly gameVersion: string; readonly mods: string }
  readonly updatedAt: string
  readonly changes: readonly CorrectionChange[]
}

export interface CorrectionCollection {
  readonly revision: number
  readonly entries: readonly CatalogCorrection[]
}

export const EMPTY_CORRECTIONS: CorrectionCollection = { revision: 0, entries: [] }
export type CorrectionStatus = 'applied' | 'included' | 'review' | 'unavailable' | 'competing' | 'superseded' | 'restored'
export const CORRECTION_STATUS_LABELS: Readonly<Record<CorrectionStatus, string>> = {
  competing: 'Choose a correction', superseded: 'Superseded', restored: 'Baseline restored',
  applied: 'Applied locally', included: 'Already in baseline', review: 'Needs review', unavailable: 'Source unavailable',
}

export function correctionKey(correction: Pick<CatalogCorrection, 'target'>): string {
  return entityDefinitionKey(correction.target)
}

export function sameCorrectionValue(left: unknown, right: unknown): boolean {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize)
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, normalize(entry)]))
    return value
  }
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right))
}

export function correctionSource(catalogs: readonly CatalogSnapshot[], target: CatalogRef) {
  const catalog = catalogs.find(entry => entry.id === target.catalogId && entry.revisionId === target.catalogRevisionId)
  const entity = catalog && Object.hasOwn(catalog.entities, target.entityId) ? catalog.entities[target.entityId] : undefined
  return catalog && entity ? { catalog, entity, claims: catalog.claims.filter(claim => claim.entityId === target.entityId) } : undefined
}

export function originalCorrectionValue(entity: CatalogEntity, change: CorrectionChange, hidden = false): unknown {
  switch (change.path) {
    case 'name': return entity.name
    case 'aliases': return entity.aliases
    case 'description': return entity.rawDescription ?? null
    case 'field': return Object.hasOwn(entity.fields, change.field) ? entity.fields[change.field] : null
    case 'visibility': return hidden
  }
}

export function activeCorrections(entries: readonly CatalogCorrection[]): readonly CatalogCorrection[] {
  const superseded = new Set(entries.flatMap(entry => entry.supersedes))
  return entries.filter(entry => !superseded.has(entry.id))
}

export function correctionTargetChanged(starting: CorrectionCollection, current: CorrectionCollection, target: CatalogRef): boolean {
  const key = correctionKey({ target })
  const decisions = (collection: CorrectionCollection) => activeCorrections(collection.entries).filter(entry => correctionKey(entry) === key).sort((left, right) => left.id.localeCompare(right.id))
  return !sameCorrectionValue(decisions(starting), decisions(current))
}

export function correctionStatus(correction: CatalogCorrection, catalogs: readonly CatalogSnapshot[], entries: readonly CatalogCorrection[] = [correction]): CorrectionStatus {
  const active = activeCorrections(entries)
  if (!active.some(entry => entry.id === correction.id)) return 'superseded'
  if (active.filter(entry => correctionKey(entry) === correctionKey(correction)).length > 1) return 'competing'
  if (!correction.changes.length) return 'restored'
  const source = correctionSource(catalogs, correction.target)
  if (!source) return 'unavailable'
  if (source.catalog.checksum !== correction.baselineChecksum || !sameCorrectionValue(source.entity.sources, correction.baselineSources) || !sameCorrectionValue(source.claims, correction.baselineClaims)) return 'review'
  const hidden = bundledHiddenEntityKeys([source.catalog]).has(correctionKey(correction))
  if (correction.changes.every(change => sameCorrectionValue(originalCorrectionValue(source.entity, change, hidden), change.after))) return 'included'
  return correction.changes.every(change => sameCorrectionValue(originalCorrectionValue(source.entity, change, hidden), change.before)) ? 'applied' : 'review'
}

export function correctedEntity(entity: CatalogEntity, correction: CatalogCorrection): CatalogEntity {
  let result = entity
  for (const change of correction.changes) {
    switch (change.path) {
      case 'name': result = { ...result, name: change.after }; break
      case 'aliases': result = { ...result, aliases: change.after }; break
      case 'description': {
        const { rawDescription: _description, ...rest } = result
        result = change.after === null ? rest : { ...rest, rawDescription: change.after }
        const field = Object.keys(result.fields).find(key => key.toLocaleLowerCase() === 'description')
        if (field) {
          const fields = { ...result.fields }
          if (change.after === null) delete fields[field]
          else fields[field] = { state: 'known', value: change.after }
          result = { ...result, fields }
        }
        break
      }
      case 'field': {
        const fields = { ...result.fields }
        if (change.after === null) delete fields[change.field]
        else {
          const value = change.after
          fields[change.field] = value.state === 'known' || value.state === 'unknown' ? {
            ...value,
            sources: [...(value.sources ?? []), { sourceId: `correction:${correction.id}`, snapshot: correction.updatedAt, locator: correction.evidence || 'Evidence not supplied', applicability: `${correction.confidence === 'tentative' ? 'Tentative' : 'User-confirmed'} local correction; ${correction.context.platform || 'platform unknown'}; ${correction.context.gameVersion || 'version unknown'}; ${correction.context.mods || 'mods unknown'}` }],
          } : value
        }
        result = synchronizePlanningField({ ...result, fields }, change.field)
        break
      }
      case 'visibility': break
    }
  }
  return result
}

export function projectCorrectedCatalogs(catalogs: readonly CatalogSnapshot[], corrections: readonly CatalogCorrection[]): readonly CatalogSnapshot[] {
  const applied = new Map(corrections.filter(entry => correctionStatus(entry, catalogs, corrections) === 'applied').map(entry => [correctionKey(entry), entry]))
  if (!applied.size) return catalogs
  return catalogs.map(catalog => {
    let changed = false
    const correctedFields = new Map<string, Set<string>>()
    const entities = Object.fromEntries(Object.entries(catalog.entities).map(([id, entity]) => {
      const correction = applied.get(entityDefinitionKey({ kind: 'catalog', catalogId: catalog.id, catalogRevisionId: catalog.revisionId, entityId: entity.id }))
      if (!correction) return [id, entity]
      changed = true
      correctedFields.set(id, new Set(correction.changes.flatMap(change => change.path === 'field' ? [change.field.toLocaleLowerCase().trim()] : change.path === 'description' ? ['description'] : [])))
      return [id, correctedEntity(entity, correction)]
    }))
    if (!changed) return catalog
    return { ...catalog, entities, claims: catalog.claims.filter(claim => !correctedFields.get(claim.entityId)?.has(claim.field.toLocaleLowerCase().trim())) }
  })
}

export function hiddenCorrectionKeys(catalogs: readonly CatalogSnapshot[], corrections: readonly CatalogCorrection[]): ReadonlySet<string> {
  const hidden = new Set(bundledHiddenEntityKeys(catalogs))
  for (const entry of corrections) {
    if (correctionStatus(entry, catalogs, corrections) !== 'applied') continue
    const visibility = entry.changes.find(change => change.path === 'visibility')
    if (visibility?.after) hidden.add(correctionKey(entry))
    else if (visibility) hidden.delete(correctionKey(entry))
  }
  return hidden
}

export function mergeCorrections(existing: readonly CatalogCorrection[], incoming: readonly CatalogCorrection[]): readonly CatalogCorrection[] {
  const merged = new Map(existing.map(entry => [entry.id, entry]))
  for (const entry of incoming) {
    const previous = merged.get(entry.id)
    if (previous && !sameCorrectionValue(previous, entry)) throw new Error('A correction ID has different content. Create a new decision that explicitly supersedes it.')
    merged.set(entry.id, entry)
  }
  return [...merged.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

export function correctionExportClosure(entries: readonly CatalogCorrection[], selected: ReadonlySet<string>): readonly CatalogCorrection[] {
  const byId = new Map(entries.map(entry => [entry.id, entry]))
  const included = new Set<string>()
  const visit = (id: string) => {
    if (included.has(id)) return
    const entry = byId.get(id)
    if (!entry) return
    included.add(id)
    entry.supersedes.forEach(visit)
  }
  selected.forEach(visit)
  return entries.filter(entry => included.has(entry.id))
}

const CONTRIBUTION_FIELDS = new Set(['Accuracy', 'Agility', 'Attack', 'Crit. Chance', 'Crit. Damage', 'Def. Pierce', 'Defense', 'Dexterity', 'Evasion', 'Luck', 'Max. HP', 'Max. MP', 'Mind', 'Res. Pierce', 'Resistance', 'Speed', 'Spirit', 'Strength', 'Vitality'])

function numericKnowledge(value: Knowledge<JsonValue> | undefined): Knowledge<number> {
  const valid = (candidate: JsonValue): candidate is number => typeof candidate === 'number' && Number.isFinite(candidate)
  if (value?.state === 'known' && valid(value.value)) return { ...value, value: value.value }
  if (value?.state === 'conflicting' && value.claims.every(claim => valid(claim.value))) return { state: 'conflicting', claims: value.claims.map(claim => ({ ...claim, value: claim.value as number })) }
  if (value?.state === 'unknown' || value?.state === 'notApplicable') return value
  return { state: 'unknown', reason: 'The corrected source does not establish a valid numeric planning value' }
}

export function synchronizePlanningField(entity: CatalogEntity, field: string): CatalogEntity
export function synchronizePlanningField(entity: PersonalDefinition, field: string): PersonalDefinition
export function synchronizePlanningField(entity: CatalogEntity | PersonalDefinition, field: string): CatalogEntity | PersonalDefinition {
  const value = entity.fields[field]
  const normalized = field.toLocaleLowerCase().trim()
  if (normalized === 'pp' || normalized === 'pp cost') return { ...entity, ppCost: numericKnowledge(value) }
  if (normalized === 'description') {
    const { rawDescription: _description, ...rest } = entity
    return value?.state === 'known' && typeof value.value === 'string' ? { ...rest, rawDescription: value.value } : rest
  }
  if (CONTRIBUTION_FIELDS.has(field) && entity.kind === 'item') {
    const numeric = numericKnowledge(value)
    const contribution = numeric.state === 'known' ? { ...numeric, value: { value: numeric.value, unit: 'listed flat value' } } : numeric.state === 'conflicting' ? { ...numeric, claims: numeric.claims.map(claim => ({ ...claim, value: { value: claim.value, unit: 'listed flat value' } })) } : numeric
    return { ...entity, listedContributions: { ...entity.listedContributions, [field]: contribution } }
  }
  return entity
}

export function correctionReviewIssues(correction: CatalogCorrection, catalogs: readonly CatalogSnapshot[], entries: readonly CatalogCorrection[] = [correction]): readonly string[] {
  const issues: string[] = []
  const status = correctionStatus(correction, catalogs, entries)
  if (status !== 'applied') issues.push(CORRECTION_STATUS_LABELS[status])
  if (correction.confidence !== 'confirmed') issues.push('Still tentative')
  if (!correction.reason.trim()) issues.push('Rationale is missing')
  if (!correction.evidence.trim()) issues.push('Evidence is missing')
  if (!correction.context.platform.trim() || !correction.context.gameVersion.trim() || !correction.context.mods.trim()) issues.push('Platform, game version, and enabled mods must be documented')
  if (correction.changes.some(change => change.path === 'field' && (change.after?.state === 'unknown' || change.after?.state === 'conflicting'))) issues.push('Contains unresolved knowledge')
  return issues
}

export function historicalCatalogKeys(catalogs: readonly CatalogSnapshot[]): ReadonlySet<string> {
  return new Set(catalogs.flatMap(catalog => {
    const legacy = catalog.legacy
    const previous = legacy && typeof legacy === 'object' && 'previousRevisionId' in legacy ? legacy.previousRevisionId : undefined
    return typeof previous === 'string' ? [JSON.stringify([catalog.id, previous])] : []
  }))
}

export function bundledHiddenEntityKeys(catalogs: readonly CatalogSnapshot[]): ReadonlySet<string> {
  return new Set(catalogs.flatMap(catalog => {
    const legacy = catalog.legacy
    const hidden = legacy && typeof legacy === 'object' && 'hiddenEntityIds' in legacy ? legacy.hiddenEntityIds : undefined
    return Array.isArray(hidden) ? hidden.filter((id): id is string => typeof id === 'string').flatMap(id => {
      const entity = catalog.entities[id]
      return entity ? [entityDefinitionKey({ kind: 'catalog', catalogId: catalog.id, catalogRevisionId: catalog.revisionId, entityId: entity.id })] : []
    }) : []
  }))
}
