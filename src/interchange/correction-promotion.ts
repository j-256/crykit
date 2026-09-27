import { z } from 'zod'
import { activeCorrections, correctionReviewIssues, hiddenCorrectionKeys, correctionKey, mergeCorrections, projectCorrectedCatalogs, type CatalogCorrection } from '../domain/corrections'
import type { CatalogRevisionId, CatalogSnapshot, JsonValue, Timestamp } from '../domain/types'
import { NativeCatalogSnapshotSchema } from './native-schema'
import { sha256 } from './util'
import { parseCorrectionCollection } from './corrections'

function parseReviewedCatalogDecisions(catalog: CatalogSnapshot): readonly CatalogCorrection[] {
  const legacy = catalog.legacy
  if (!legacy || typeof legacy !== 'object' || !('reviewedCorrections' in legacy)) return []
  return parseCorrectionCollection(JSON.stringify({ revision: 0, entries: legacy.reviewedCorrections })).entries
}

export function reviewedCatalogDecisions(catalog: CatalogSnapshot): readonly CatalogCorrection[] {
  try { return parseReviewedCatalogDecisions(catalog) } catch { return [] }
}

export interface ReviewedCatalogBundle {
  readonly format: 'crystal-companion-reviewed-catalogs'
  readonly version: 1
  readonly current: { readonly catalogId: string; readonly revisionId: string } | null
  readonly catalogs: readonly CatalogSnapshot[]
}

const bundleSchema = z.object({
  format: z.literal('crystal-companion-reviewed-catalogs'),
  version: z.literal(1),
  current: z.object({ catalogId: z.string().min(1), revisionId: z.string().min(1) }).strict().nullable(),
  catalogs: z.array(NativeCatalogSnapshotSchema).max(100),
}).strict()

export function validateReviewedCatalogBundle(value: unknown): ReviewedCatalogBundle {
  const result = bundleSchema.parse(value) as unknown as ReviewedCatalogBundle
  for (const catalog of result.catalogs) parseReviewedCatalogDecisions(catalog)
  const keys = result.catalogs.map(catalog => JSON.stringify([catalog.id, catalog.revisionId]))
  if (new Set(keys).size !== keys.length) throw new Error('Reviewed catalogs contain repeated revision identities')
  if (result.current && !result.catalogs.some(catalog => catalog.id === result.current!.catalogId && catalog.revisionId === result.current!.revisionId)) throw new Error('The selected reviewed catalog revision is missing')
  if (!result.current && result.catalogs.length) throw new Error('Select an explicit current catalog revision')
  return result
}

export function catalogContentForChecksum(catalog: Omit<CatalogSnapshot, 'checksum'>): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonical(entry)]))
    return value
  }
  return JSON.stringify(canonical(catalog))
}

export async function verifyReviewedCatalogChecksums(bundle: ReviewedCatalogBundle): Promise<void> {
  for (const snapshot of bundle.catalogs) {
    if (!snapshot.checksum.startsWith('reviewed:sha256:')) continue
    const { checksum, ...content } = snapshot
    if (checksum !== `reviewed:sha256:${await sha256(new TextEncoder().encode(catalogContentForChecksum(content)))}`) throw new Error(`Reviewed catalog checksum mismatch: ${snapshot.revisionId}`)
  }
}

export async function promoteCorrections(
  baseline: CatalogSnapshot,
  decisions: readonly CatalogCorrection[],
  revisionId: string,
  reviewedAt: string,
): Promise<CatalogSnapshot> {
  if (!revisionId.trim() || revisionId === baseline.revisionId) throw new Error('Promotion requires a new catalog revision identity')
  const active = activeCorrections(decisions).filter(entry => entry.changes.length)
  if (!active.length) throw new Error('There are no active corrections to promote')
  for (const entry of active) {
    const issues = correctionReviewIssues(entry, [baseline], decisions)
    if (issues.length) throw new Error(`${entry.baselineName}: ${issues.join('; ')}`)
  }
  const projected = projectCorrectedCatalogs([baseline], decisions)[0]!
  const { checksum: _checksum, ...snapshot } = projected
  const previousLegacy = baseline.legacy && typeof baseline.legacy === 'object' && !Array.isArray(baseline.legacy) ? baseline.legacy : {}
  const hidden = hiddenCorrectionKeys([baseline], decisions)
  const history = parseCorrectionCollection(JSON.stringify({ revision: 0, entries: mergeCorrections(parseReviewedCatalogDecisions(baseline), decisions) })).entries
  const content: Omit<CatalogSnapshot, 'checksum'> = {
    ...snapshot,
    revisionId: revisionId as CatalogRevisionId,
    importedAt: reviewedAt as Timestamp,
    legacy: {
      ...previousLegacy,
      previousRevisionId: baseline.revisionId,
      previousChecksum: baseline.checksum,
      reviewedCorrections: JSON.parse(JSON.stringify(history)) as JsonValue,
      hiddenEntityIds: Object.values(baseline.entities).filter(entity => hidden.has(correctionKey({ target: { kind: 'catalog', catalogId: baseline.id, catalogRevisionId: baseline.revisionId, entityId: entity.id } }))).map(entity => entity.id),
    },
  }
  const checksum = `reviewed:sha256:${await sha256(new TextEncoder().encode(catalogContentForChecksum(content)))}`
  return NativeCatalogSnapshotSchema.parse({ ...content, checksum }) as unknown as CatalogSnapshot
}
