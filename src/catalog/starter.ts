import type {
  CatalogEntity,
  CatalogEntityKind,
  CatalogId,
  CatalogRevisionId,
  CatalogSnapshot,
  EntityId,
  Knowledge,
  Timestamp,
} from '../domain/types'
import {
  STARTER_CATALOG_CONTENT_DIGEST,
  STARTER_NAME_RECORDS,
  STARTER_SOURCE_URLS,
} from './data'

export const STARTER_CATALOG_ID = 'crystal-project-public-starter' as CatalogId
export const STARTER_CATALOG_REVISION_ID = 'names-v1' as CatalogRevisionId

const MECHANICS_UNKNOWN_REASON = 'The built-in starter catalog contains identity and name evidence only'
const SOURCE_APPLICABILITY = 'Name evidence only; platform and enabled-mod applicability are unverified'

const UNKNOWN_STRINGS: Knowledge<readonly string[]> = {
  state: 'unknown',
  reason: MECHANICS_UNKNOWN_REASON,
}
const UNKNOWN_NUMBER: Knowledge<number> = {
  state: 'unknown',
  reason: MECHANICS_UNKNOWN_REASON,
}
const UNKNOWN_REQUIREMENTS: CatalogEntity['requirements'] = {
  state: 'unknown',
  reason: MECHANICS_UNKNOWN_REASON,
}

function deepFreeze<Value>(value: Value): Value {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

function createEntity(record: typeof STARTER_NAME_RECORDS[number]): CatalogEntity {
  const [id, kind, name, source] = record
  return {
    id: id as EntityId,
    kind,
    name,
    aliases: [],
    fields: {},
    slotKinds: UNKNOWN_STRINGS,
    occupiesSlots: UNKNOWN_NUMBER,
    ppCost: UNKNOWN_NUMBER,
    requirements: UNKNOWN_REQUIREMENTS,
    grants: UNKNOWN_STRINGS,
    sources: [{
      sourceId: STARTER_SOURCE_URLS[source],
      locator: name,
      applicability: SOURCE_APPLICABILITY,
    }],
  }
}

const entities = Object.fromEntries(
  STARTER_NAME_RECORDS.map((record) => [record[0], createEntity(record)]),
) as Readonly<Record<string, CatalogEntity>>

export const STARTER_CATALOG_COUNTS = deepFreeze(
  STARTER_NAME_RECORDS.reduce<Partial<Record<CatalogEntityKind, number>>>((counts, [, kind]) => {
    counts[kind] = (counts[kind] ?? 0) + 1
    return counts
  }, {}),
)

export const STARTER_CATALOG: CatalogSnapshot = deepFreeze({
  id: STARTER_CATALOG_ID,
  revisionId: STARTER_CATALOG_REVISION_ID,
  schemaVersion: '1.0.0',
  checksum: `builtin:sha256:${STARTER_CATALOG_CONTENT_DIGEST}`,
  importedAt: '2026-09-24T00:00:00.000Z' as Timestamp,
  applicability: {
    state: 'unknown',
    reason: 'This partial public names catalog does not establish complete Nintendo Switch or mod-pack coverage',
  },
  rights: {
    state: 'unknown',
    reason: 'Only factual names and source links are bundled; broader source reuse rights vary by source',
  },
  entities,
  claims: [],
  legacy: {
    coverage: 'partial-names-only',
    provenance: 'public-static-sources',
  },
})
