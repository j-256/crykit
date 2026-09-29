import type {
  CatalogClaim,
  CatalogEntity,
  CatalogEntityKind,
  CatalogRef,
  CatalogSnapshot,
  EntityId,
  InventoryEvent,
  JsonValue,
  Knowledge,
  PartyProgressRecord,
  LocalData,
  GameSetupRevision,
  GameSetupRevisionId,
  SourceRef,
  Timestamp,
} from '../domain/types'
import type { ImportCounts, ImportPreview, ImportProblem, SourceArchiveRecord } from './types'
import { AppDataError } from './errors'
import { normalizeImportedFieldName } from './field-names'
import {
  asCatalogId,
  asCatalogRevisionId,
  asImportReceiptId,
  asInventoryEventId,
  asProgressRecordId,
  createBlankLocalData,
  nowTimestamp,
  randomId,
  sha256,
  stableSourceId,
} from './util'
import type { RawXlsxCell, RawXlsxRow, RawXlsxTable, RawXlsxWorkbook } from './xlsx'
import { parseXlsx } from './xlsx'

interface PrimaryTableConfig {
  readonly kind: CatalogEntityKind
  readonly nameColumn: string
  readonly idColumn?: string
}

const PRIMARY_TABLES: Readonly<Record<string, PrimaryTableConfig>> = Object.freeze({
  CPClasses: { kind: 'class', nameColumn: 'Class', idColumn: 'Class ID' },
  CPInnates: { kind: 'innate', nameColumn: 'Innate', idColumn: 'Innate ID' },
  CPPassives: { kind: 'passive', nameColumn: 'Passive', idColumn: 'Passive ID' },
  CPAbilities: { kind: 'ability', nameColumn: 'Ability', idColumn: 'Ability ID' },
  CPBaseEquipment: { kind: 'item', nameColumn: 'Item', idColumn: 'Item ID' },
  CPExpansionItems: { kind: 'item', nameColumn: 'Item', idColumn: 'Item ID' },
  CPExpansionLocations: { kind: 'location', nameColumn: 'Item / group' },
  CPCrafting: { kind: 'recipe', nameColumn: 'Output' },
  CPConflicts: { kind: 'other', nameColumn: 'Topic', idColumn: 'Issue' },
  CPPlannerRules: { kind: 'other', nameColumn: 'Rule', idColumn: 'Rule ID' },
})

const MAX_IMPORT_ID_LENGTH = 1_024
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/
const PP_FIELDS = new Set(['pp', 'pp cost'])

function importedId(value: string, label: string): string {
  if (value.trim().length === 0 || value.length > MAX_IMPORT_ID_LENGTH || CONTROL_CHARACTER.test(value)) {
    throw new AppDataError('schema-mismatch', `${label} must be nonempty, bounded text without control characters`, {
      recoverable: true,
    })
  }
  return value
}

function uniqueEntityId(
  entities: Readonly<Record<string, CatalogEntity>>,
  preferred: string,
  sourceScopedFallback: string,
): string {
  if (!Object.hasOwn(entities, preferred)) return preferred
  let candidate = sourceScopedFallback
  let suffix = 2
  while (Object.hasOwn(entities, candidate)) {
    candidate = `${sourceScopedFallback}:duplicate:${suffix}`
    suffix += 1
  }
  return candidate
}

function cellJson(cell: RawXlsxCell | undefined): JsonValue | undefined {
  if (!cell || cell.kind === 'blank') return undefined
  if (cell.kind === 'formula') {
    return {
      formula: cell.formula ?? '',
      cachedKind: cell.cachedKind ?? 'blank',
      cachedValue: cell.value ?? null,
      raw: cell.raw ?? null,
    }
  }
  return cell.value
}

function rawCellJson(cell: RawXlsxCell): JsonValue {
  return {
    address: cell.address,
    kind: cell.kind,
    value: cell.value ?? null,
    raw: cell.raw ?? null,
    formula: cell.formula ?? null,
    cachedKind: cell.cachedKind ?? null,
  }
}

function rawRowJson(row: RawXlsxRow): JsonValue {
  return {
    rowNumber: row.rowNumber,
    locator: row.locator,
    values: Object.fromEntries(Object.entries(row.values).map(([column, cell]) => [column, rawCellJson(cell)])),
  }
}

function textCell(row: RawXlsxRow, column: string): string | undefined {
  const value = cellJson(row.values[column])
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function sourceFor(digest: string, row: RawXlsxRow): SourceRef {
  return {
    sourceId: stableSourceId(digest),
    locator: row.locator,
    snapshot: `sha256:${digest}`,
  }
}

function knownOrUnknown(value: JsonValue | undefined, source: SourceRef): Knowledge<JsonValue> {
  return value === undefined
    ? { state: 'unknown', reason: 'Blank in imported workbook', sources: [source] }
    : { state: 'known', value, sources: [source] }
}

function cellKnowledge(cell: RawXlsxCell, source: SourceRef): Knowledge<JsonValue> {
  if (cell.kind === 'formula') {
    return {
      state: 'unknown',
      reason: 'Formula and cached value were retained as inert source data',
      sources: [source],
    }
  }
  return knownOrUnknown(cellJson(cell), source)
}

function entityFields(
  row: RawXlsxRow,
  source: SourceRef,
  omittedColumns: ReadonlySet<string>,
): Readonly<Record<string, Knowledge<JsonValue>>> {
  return Object.fromEntries(
    Object.entries(row.values)
      .filter(([column]) => !omittedColumns.has(column))
      .map(([column, cell]) => [column, cellKnowledge(cell, source)]),
  )
}

function catalogRef(catalog: CatalogSnapshot, entityId: string): CatalogRef {
  return {
    kind: 'catalog',
    catalogId: catalog.id,
    catalogRevisionId: catalog.revisionId,
    entityId: entityId as EntityId,
  }
}

function sourceScopedId(digest: string, table: RawXlsxTable, row: RawXlsxRow): string {
  return `xlsx:${digest.slice(0, 16)}:${table.name}:${row.rowNumber}`
}

function rawDescription(row: RawXlsxRow): string | undefined {
  for (const column of ['Effect', 'Effects · raw', 'Rule', 'Evidence / boundary', 'Source A claim']) {
    const value = textCell(row, column)
    if (value) return value
  }
  return undefined
}

function ppCost(row: RawXlsxRow, source: SourceRef): Knowledge<number> | undefined {
  const entry = Object.entries(row.values).find(([field]) => PP_FIELDS.has(normalizeImportedFieldName(field)))
  if (!entry) return undefined
  const [, cell] = entry
  if (cell.kind === 'formula') {
    return { state: 'unknown', reason: 'Formula and cached PP values are retained as inert source data', sources: [source] }
  }
  const value = cellJson(cell)
  return typeof value === 'number'
    ? { state: 'known', value, sources: [source] }
    : { state: 'unknown', reason: 'The explicit PP field is not a numeric source value', sources: [source] }
}

function buildCatalog(
  workbook: RawXlsxWorkbook,
  digest: string,
  importedAt: Timestamp,
  warnings: ImportProblem[],
  ambiguousEntityIds: Set<string>,
): CatalogSnapshot {
  const entities = Object.create(null) as Record<string, CatalogEntity>
  const claims: CatalogClaim[] = []
  const namesByKind = new Map<string, string | null>()

  for (const table of workbook.tables) {
    const config = PRIMARY_TABLES[table.name]
    if (!config) continue
    for (const row of table.rows) {
      const source = sourceFor(digest, row)
      const name = textCell(row, config.nameColumn)
      if (!name) {
        warnings.push({
          severity: 'warning',
          code: 'missing-entity-name',
          message: `${table.sheet} contains a row without an entity name`,
          locator: row.locator,
        })
        continue
      }
      const suppliedId = config.idColumn ? textCell(row, config.idColumn) : undefined
      const fallbackId = sourceScopedId(digest, table, row)
      const preferredId = importedId(suppliedId ?? fallbackId, `${row.locator} identity`)
      const id = uniqueEntityId(entities, preferredId, fallbackId)
      if (id !== preferredId) {
        ambiguousEntityIds.add(preferredId)
        warnings.push({
          severity: 'warning',
          code: 'duplicate-entity-id',
          message: `A duplicate source ID was preserved as a separate unresolved record: ${preferredId}`,
          locator: row.locator,
        })
      }
      const omitted = new Set([config.nameColumn, ...(config.idColumn ? [config.idColumn] : [])])
      const description = rawDescription(row)
      const documentedPpCost = ppCost(row, source)
      entities[id] = {
        id: id as EntityId,
        kind: config.kind,
        name,
        aliases: [],
        fields: entityFields(row, source, omitted),
        sources: [source],
        ...(description === undefined ? {} : { rawDescription: description }),
        ...(documentedPpCost === undefined ? {} : { ppCost: documentedPpCost }),
      }
      const nameKey = `${config.kind}:${name.toLocaleLowerCase()}`
      namesByKind.set(nameKey, namesByKind.has(nameKey) ? null : id)
    }
  }

  const auxiliary: Readonly<Record<string, { kind: CatalogEntityKind; nameColumn: string; idColumn?: string }>> = {
    CPGrowth: { kind: 'class', nameColumn: 'Class' },
    CPMonsterMagic: { kind: 'monsterMagic', nameColumn: 'Spell', idColumn: 'Ability ID' },
    CPExpansionLocations: { kind: 'location', nameColumn: 'Item / group', idColumn: 'Exact item ID' },
    CPExpansionStats: { kind: 'item', nameColumn: 'Item', idColumn: 'Item ID' },
    CPUnparsedStats: { kind: 'item', nameColumn: 'Item' },
    CPCoverage: { kind: 'class', nameColumn: 'Class' },
  }
  for (const table of workbook.tables) {
    const config = auxiliary[table.name]
    if (!config) continue
    for (const row of table.rows) {
      const source = sourceFor(digest, row)
      const name = textCell(row, config.nameColumn)
      const suppliedId = config.idColumn ? textCell(row, config.idColumn) : undefined
      const matchedByName = name ? namesByKind.get(`${config.kind}:${name.toLocaleLowerCase()}`) : undefined
      const ambiguousId = suppliedId ? ambiguousEntityIds.has(suppliedId) : false
      const entityId = suppliedId && !ambiguousId && entities[suppliedId]
        ? suppliedId
        : !ambiguousId
          ? matchedByName ?? undefined
          : undefined
      if (entityId) {
        if (table.name === 'CPMonsterMagic') {
          const existing = entities[entityId]
          if (existing) entities[entityId] = { ...existing, kind: 'monsterMagic' }
        }
        for (const [field, cell] of Object.entries(row.values)) {
          if (field === config.nameColumn || field === config.idColumn) continue
          claims.push({
            entityId: entityId as EntityId,
            field: `${table.name}.${field}`,
            value: cellKnowledge(cell, source),
            sources: [source],
          })
        }
      } else {
        if (table.name === 'CPMonsterMagic' && name) {
          const fallbackId = sourceScopedId(digest, table, row)
          const preferredId = importedId(suppliedId ?? fallbackId, `${row.locator} identity`)
          const id = uniqueEntityId(entities, preferredId, fallbackId)
          if (id !== preferredId) {
            ambiguousEntityIds.add(preferredId)
            warnings.push({ severity: 'warning', code: 'duplicate-entity-id', message: `A duplicate source ID was preserved separately: ${preferredId}`, locator: row.locator })
          }
          const description = rawDescription(row)
          const documentedPpCost = ppCost(row, source)
          entities[id] = {
            id: id as EntityId,
            kind: 'monsterMagic',
            name,
            aliases: [],
            fields: entityFields(row, source, new Set([config.nameColumn, ...(config.idColumn ? [config.idColumn] : [])])),
            sources: [source],
            ...(description === undefined ? {} : { rawDescription: description }),
            ...(documentedPpCost === undefined ? {} : { ppCost: documentedPpCost }),
          }
          continue
        }
        warnings.push({
          severity: 'warning',
          code: ambiguousId ? 'ambiguous-entity-id' : 'unresolved-reference-row',
          message: ambiguousId
            ? `${table.sheet} cites a duplicated source ID and was left unlinked`
            : `${table.sheet} contains a row that was retained without an automatic entity link`,
          locator: row.locator,
        })
      }
    }
  }

  const conflictTable = workbook.tables.find((table) => table.name === 'CPConflicts')
  if (conflictTable) {
    for (const row of conflictTable.rows) {
      const topic = textCell(row, 'Topic')?.toLocaleLowerCase()
      if (!topic) continue
      const candidates = Object.values(entities)
        .filter((entity) => entity.kind !== 'other')
        .filter((entity) => topic === entity.name.toLocaleLowerCase() || topic.startsWith(`${entity.name.toLocaleLowerCase()} `))
        .sort((left, right) => right.name.length - left.name.length)
      const best = candidates[0]
      const tied = best ? candidates.filter((candidate) => candidate.name.length === best.name.length) : []
      if (!best || tied.length !== 1) continue
      const source = sourceFor(digest, row)
      for (const field of ['Source A claim', 'Source B claim', 'Handling', 'Status', 'Source A', 'Source B']) {
        const cell = row.values[field]
        if (!cell) continue
        claims.push({
          entityId: best.id,
          field: `Conflict.${field}`,
          value: cellKnowledge(cell, source),
          sources: [source],
        })
      }
    }
  }

  return {
    id: asCatalogId('crystal-project:reference'),
    revisionId: asCatalogRevisionId(`sha256:${digest}`),
    schemaVersion: 'xlsx-v2',
    checksum: `sha256:${digest}`,
    importedAt,
    applicability: {
      state: 'unknown',
      reason: 'The workbook does not establish an exact game and mod version',
    },
    rights: {
      state: 'unknown',
      reason: 'The workbook sources require a source-by-source redistribution review',
    },
    entities,
    claims,
    legacy: {
      sheets: workbook.sheetNames,
      tables: workbook.tables.map((table) => ({
        sheet: table.sheet,
        name: table.name,
        range: table.range,
        columns: table.columns,
        group: table.group,
        declaredCellCount: table.declaredCellCount,
        retainedRowCount: table.rows.length,
      })),
      formulaCount: workbook.formulaCount,
      ignoredPresentationRows: workbook.ignoredPresentationRows,
    },
  }
}

function progressFromWorkbook(
  workbook: RawXlsxWorkbook,
  catalog: CatalogSnapshot,
  digest: string,
  importedAt: Timestamp,
  warnings: ImportProblem[],
  ambiguousEntityIds: ReadonlySet<string>,
): Readonly<Record<string, PartyProgressRecord>> {
  const table = workbook.tables.find((candidate) => candidate.name === 'CPSealProgress')
  if (!table) return {}
  const classIdsByName = new Map<string, EntityId | null>()
  for (const entity of Object.values(catalog.entities).filter((candidate) => candidate.kind === 'class')) {
    const key = entity.name.toLocaleLowerCase()
    classIdsByName.set(key, classIdsByName.has(key) ? null : entity.id)
  }
  const progress: Record<string, PartyProgressRecord> = {}
  for (const row of table.rows) {
    const name = textCell(row, 'Class')
    const suppliedId = textCell(row, 'Class ID')
    const ambiguousId = suppliedId ? ambiguousEntityIds.has(suppliedId) : false
    const classId = suppliedId && !ambiguousId && catalog.entities[suppliedId]?.kind === 'class'
      ? catalog.entities[suppliedId]?.id
      : !ambiguousId && name
        ? classIdsByName.get(name.toLocaleLowerCase()) ?? undefined
        : undefined
    if (!classId) {
      warnings.push({
        severity: 'warning',
        code: 'unresolved-progress-class',
        message: 'A party progress row could not be linked to a class definition',
        locator: row.locator,
      })
      continue
    }
    const displayName = name ?? catalog.entities[classId]?.name ?? 'Unnamed class'
    const mastery = textCell(row, 'Mastery')
    const seal = textCell(row, 'Seal')
    const location = textCell(row, 'Master / seal location')
    const source = sourceFor(digest, row)
    const id = asProgressRecordId(`progress:${digest.slice(0, 16)}:${row.rowNumber}`)
    const stage = seal === 'Collected'
      ? { state: 'known' as const, value: 'sealAcquired' as const, sources: [source] }
      : mastery === 'Mastered' && seal === 'Awaiting collection'
        ? { state: 'known' as const, value: 'mastered' as const, sources: [source] }
        : mastery === 'In progress'
          ? { state: 'known' as const, value: 'unlocked' as const, sources: [source] }
          : { state: 'unknown' as const, reason: 'The imported progress labels do not establish a stage', sources: [source] }
    progress[id] = {
      id,
      revision: 0,
      subject: catalogRef(catalog, classId),
      displayName,
      stage,
      unlocked: mastery === 'Mastered' || mastery === 'In progress'
        ? { state: 'known', value: true, sources: [source] }
        : { state: 'unknown', reason: 'Unlock state was not established', sources: [source] },
      partyMastery: mastery === 'Mastered'
        ? { state: 'known', value: true, sources: [source] }
        : mastery === 'In progress'
          ? { state: 'known', value: false, sources: [source] }
          : { state: 'unknown', reason: 'Party mastery was not established', sources: [source] },
      collection: seal === 'Collected'
        ? { state: 'known', value: true, sources: [source] }
        : seal === 'Awaiting collection'
          ? { state: 'known', value: false, sources: [source] }
          : { state: 'unknown', reason: 'Seal collection was not confirmed', sources: [source] },
      masterLocation: location
        ? { state: 'known', value: location, sources: [source] }
        : { state: 'unknown', reason: 'No master location was recorded', sources: [source] },
      sources: [source],
      updatedAt: importedAt,
    }
  }
  return progress
}

function inventoryEventsFromWorkbook(
  workbook: RawXlsxWorkbook,
  catalog: CatalogSnapshot,
  digest: string,
  importedAt: Timestamp,
  warnings: ImportProblem[],
  ambiguousEntityIds: ReadonlySet<string>,
): Readonly<Record<string, InventoryEvent>> {
  const table = workbook.tables.find((candidate) => candidate.name === 'CPInventory')
  if (!table) return {}
  const itemsByName = new Map<string, EntityId | null>()
  for (const entity of Object.values(catalog.entities).filter((candidate) => candidate.kind === 'item')) {
    const key = entity.name.toLocaleLowerCase()
    itemsByName.set(key, itemsByName.has(key) ? null : entity.id)
  }
  const events: Record<string, InventoryEvent> = {}
  for (const row of table.rows) {
    const name = textCell(row, 'Item')
    const acquired = cellJson(row.values.Acquired)
    if (acquired !== true) continue
    const suppliedId = textCell(row, 'Item ID')
    const ambiguousId = suppliedId ? ambiguousEntityIds.has(suppliedId) : false
    const entityId = suppliedId && !ambiguousId && catalog.entities[suppliedId]?.kind === 'item'
      ? catalog.entities[suppliedId]?.id
      : !ambiguousId && name
        ? itemsByName.get(name.toLocaleLowerCase()) ?? undefined
        : undefined
    if (!entityId) {
      warnings.push({
        severity: 'warning',
        code: 'unresolved-inventory-item',
        message: 'A historical acquisition was retained but could not be linked to an item definition',
        locator: row.locator,
      })
      continue
    }
    const observedName = name ?? catalog.entities[entityId]?.name
    const source = sourceFor(digest, row)
    const id = asInventoryEventId(`event:${digest.slice(0, 16)}:${row.rowNumber}`)
    events[id] = {
      id,
      ref: catalogRef(catalog, entityId),
      observedName,
      kind: 'acquired',
      quantity: { state: 'unknown', reason: 'Historical acquisition did not establish an amount', sources: [source] },
      recordedAt: importedAt,
      sources: [source],
      note: 'Historical acquisition only; current possession and quantity remain unknown',
    }
  }
  return events
}

function gameSetupFromWorkbook(
  workbook: RawXlsxWorkbook,
  catalog: CatalogSnapshot,
  digest: string,
  importedAt: Timestamp,
): GameSetupRevision | undefined {
  const table = workbook.tables.find((candidate) => candidate.name === 'CPPlaythroughContext')
  if (!table) return undefined
  const context = new Map(table.rows.map((row) => [textCell(row, 'Field'), textCell(row, 'Last-reported value')]))
  const platform = context.get('Platform')
  const sourceRow = table.rows.find((row) => textCell(row, 'Field') === 'Platform')
  const source = sourceRow ? sourceFor(digest, sourceRow) : undefined
  const id = `gameSetup-revision:${digest.slice(0, 16)}` as GameSetupRevisionId
  return {
    id,
    gameSetupId: `gameSetup:${digest.slice(0, 16)}` as GameSetupRevision['gameSetupId'],
    revision: 1,
    label: 'Imported playthrough context',
    platform: platform
      ? { state: 'known', value: platform, sources: source ? [source] : [] }
      : { state: 'unknown', reason: 'Platform was not supplied' },
    gameVersion: { state: 'unknown', reason: 'Exact game version was not supplied' },
    mode: { state: 'unknown', reason: 'Standard/Vanilla mode was not supplied' },
    mods: { state: 'unknown', reason: 'Exact mod IDs, versions, and load order were not supplied' },
    ppLimit: { state: 'unknown', reason: 'No passive point limit was supplied' },
    ppCostsNonNegative: { state: 'unknown', reason: 'No complete Game Setup verification was supplied' },
    slots: [],
    catalogLock: { [catalog.id]: catalog.revisionId },
    createdAt: importedAt,
  }
}

function counts(workbook: RawXlsxWorkbook): ImportCounts {
  const result = { reference: 0, personal: 0, mixed: 0, ignored: workbook.ignoredPresentationRows }
  for (const table of workbook.tables) result[table.group] += table.rows.length
  return result
}

export async function previewXlsx(bytes: Uint8Array, filename: string): Promise<ImportPreview> {
  const digest = await sha256(bytes)
  const importedAt = nowTimestamp()
  const workbook = parseXlsx(bytes)
  const warnings: ImportProblem[] = [
    {
      severity: 'warning',
      code: 'private-source',
      message: 'This workbook mixes personal observations with reference material and will remain local',
    },
    {
      severity: 'warning',
      code: 'unreviewed-rights',
      message: 'Imported reference rows are not approved for public redistribution',
    },
  ]
  if (workbook.formulaCount > 0) {
    warnings.push({
      severity: 'warning',
      code: 'inert-formulas',
      message: `${workbook.formulaCount} workbook formulas were retained as inert source text and were not executed`,
    })
  }
  const ambiguousEntityIds = new Set<string>()
  const catalog = buildCatalog(workbook, digest, importedAt, warnings, ambiguousEntityIds)
  const localData = createBlankLocalData('Imported playthrough', importedAt)
  const gameSetup = gameSetupFromWorkbook(workbook, catalog, digest, importedAt)
  const progress = progressFromWorkbook(workbook, catalog, digest, importedAt, warnings, ambiguousEntityIds)
  const inventoryEvents = inventoryEventsFromWorkbook(workbook, catalog, digest, importedAt, warnings, ambiguousEntityIds)
  const receiptId = asImportReceiptId(`import:${digest}`)
  const playthroughId = localData.selectedPlaythroughId!
  const playthrough = localData.playthroughs[playthroughId]!
  const proposedLocalData: LocalData = {
    ...localData,
    planningGameSetupRevisionId: gameSetup?.id,
    gameSetups: gameSetup ? { [gameSetup.id]: gameSetup } : {},
    playthroughs: {
      [playthroughId]: {
        ...playthrough,
        ...(gameSetup ? { currentGameSetupRevisionId: gameSetup.id } : {}),
        progress,
        inventoryEvents,
      },
    },
    importReceipts: {
      [receiptId]: {
        id: receiptId,
        sourceFormat: 'xlsx-v2',
        sourceIdentity: `sha256:${digest}`,
        importedAt,
        localDataRevision: localData.revision,
      },
    },
  }
  const evidence = workbook.tables.flatMap((table) =>
    table.rows.map((row) => ({
      id: `evidence:${digest}:${table.name}:${row.rowNumber}`,
      sourceDigest: digest,
      group: table.group,
      kind: `xlsx-table-row:${table.name}`,
      locator: row.locator,
      sources: [sourceFor(digest, row)],
      payload: rawRowJson(row),
      private: true,
    })),
  )
  const source: SourceArchiveRecord = {
    id: stableSourceId(digest),
    digest,
    filename,
    mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    format: 'xlsx-v2',
    importedAt,
    bytes: Uint8Array.from(bytes),
  }
  return {
    id: randomId('import-preview'),
    filename,
    detectedFormat: 'xlsx-v2',
    detectedSchema: 'xlsx-v2',
    sourceDigest: digest,
    counts: counts(workbook),
    warnings,
    errors: [],
    localData: { label: playthrough.label },
    proposed: {
      localData: proposedLocalData,
      lineage: { rootLocalDataId: proposedLocalData.id },
      catalogs: [catalog],
      evidence,
      sources: [source],
      history: [],
    },
  }
}
