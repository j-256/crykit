import { MAX_ID_LENGTH } from './limits'
import type { CatalogId, CatalogRevisionId } from './types'

export const CATALOG_GAME = 'crystal-project' as const
export const MAX_SOURCE_PROJECT_ID_LENGTH = 512
const MAX_BUNDLED_SOURCE_KEY_LENGTH = 128
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/
const BUNDLED_SOURCE_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const IMPORTED_SOURCE_KEY = /^[a-z][a-z0-9]{0,15}-[a-f0-9]{64}$/
const IMPORTED_REVISION = /^(j1|b1)-([a-f0-9]{64})-(p[1-9][0-9]*)$/
const JSON_FINGERPRINT = /^json-content-v1:sha256:([a-f0-9]{64})$/

export type CatalogSourceIdentity =
  | { readonly game: typeof CATALOG_GAME; readonly origin: 'vanilla' }
  | { readonly game: typeof CATALOG_GAME; readonly origin: 'mod' | 'guide' | 'imported'; readonly key: string }
export type CatalogSourceOrigin = CatalogSourceIdentity['origin']
export type SourceRevision =
  | { readonly kind: 'bundled'; readonly version: number }
  | { readonly kind: 'imported'; readonly encoding: 'j1' | 'b1'; readonly digest: string; readonly interpretation: string }

export function parseCatalogSourceId(id: string): CatalogSourceIdentity | undefined {
  if (id.length > MAX_ID_LENGTH || CONTROL_CHARACTER.test(id)) return undefined
  const [game, origin, key, extra] = id.split('/')
  if (game !== CATALOG_GAME || extra !== undefined) return undefined
  if (origin === 'vanilla') return key === undefined ? { game, origin } : undefined
  if (origin !== 'mod' && origin !== 'guide' && origin !== 'imported' || !key) return undefined
  const valid = origin === 'imported' ? IMPORTED_SOURCE_KEY.test(key) : key.length <= MAX_BUNDLED_SOURCE_KEY_LENGTH && BUNDLED_SOURCE_KEY.test(key)
  return valid ? { game, origin, key } : undefined
}

export function formatCatalogSourceId(identity: CatalogSourceIdentity): CatalogId {
  const id = `${identity.game}/${identity.origin}${identity.origin === 'vanilla' ? '' : `/${identity.key}`}`
  if (!parseCatalogSourceId(id)) throw new Error('Invalid catalog source identity')
  return id as CatalogId
}

export function validDeclaredProjectId(id: string): boolean {
  // The declared ID is opaque; normalization would collapse distinct project namespaces
  return id.length <= MAX_SOURCE_PROJECT_ID_LENGTH && id.trim().length > 0 && !CONTROL_CHARACTER.test(id)
}

function positiveVersion(value: string): boolean {
  return Number.isSafeInteger(Number(value)) && Number(value) > 0
}

export function parseSourceRevision(origin: CatalogSourceOrigin, revision: string): SourceRevision | undefined {
  if (revision.length > MAX_ID_LENGTH || CONTROL_CHARACTER.test(revision)) return undefined
  if (origin !== 'imported') {
    const match = /^v([1-9][0-9]*)$/.exec(revision)
    return match && positiveVersion(match[1]!) ? { kind: 'bundled', version: Number(match[1]) } : undefined
  }
  const match = IMPORTED_REVISION.exec(revision)
  return match && positiveVersion(match[3]!.slice(1)) ? { kind: 'imported', encoding: match[1] as 'j1' | 'b1', digest: match[2]!, interpretation: match[3]! } : undefined
}

export function importedJsonRevision(contentFingerprint: string, interpretation: string): CatalogRevisionId {
  const match = !CONTROL_CHARACTER.test(contentFingerprint) && JSON_FINGERPRINT.exec(contentFingerprint)
  const revision = match ? `j1-${match[1]}-${interpretation}` : ''
  if (!parseSourceRevision('imported', revision)) throw new Error('Invalid imported JSON content or interpretation identity')
  return revision as CatalogRevisionId
}
