import type { JsonValue } from '../domain/types'
import { AppDataError } from './errors'
import type { ImportGroup } from './types'
import { elements, firstElement, parseXml, relationshipPartPath, resolvePackageTarget } from './xml'
import { safeUnzip } from './zip'

const SPREADSHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const DOCUMENT_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const CONTENT_TYPE_NS = 'http://schemas.openxmlformats.org/package/2006/content-types'
const XLSX_WORKBOOK_CONTENT_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
])
const MAX_TABLE_ROWS = 100_000
const MAX_TABLE_COLUMNS = 256
const MAX_TABLE_CELLS = 1_000_000
const MAX_WORKBOOK_TABLE_CELLS = 2_000_000
const DANGEROUS_COLUMN_NAMES = new Set(['__proto__', 'constructor', 'prototype'])

export type RawCellKind = 'blank' | 'string' | 'number' | 'boolean' | 'date' | 'error' | 'formula'

export interface RawXlsxCell {
  readonly address: string
  readonly kind: RawCellKind
  readonly value?: JsonValue
  readonly raw?: string
  readonly formula?: string
  readonly cachedKind?: Exclude<RawCellKind, 'formula'>
}

export interface RawXlsxRow {
  readonly rowNumber: number
  readonly locator: string
  readonly values: Readonly<Record<string, RawXlsxCell>>
}

export interface RawXlsxTable {
  readonly sheet: string
  readonly name: string
  readonly range: string
  readonly columns: readonly string[]
  readonly rows: readonly RawXlsxRow[]
  readonly group: ImportGroup
  readonly declaredCellCount: number
}

export interface RawXlsxWorkbook {
  readonly tables: readonly RawXlsxTable[]
  readonly sheetNames: readonly string[]
  readonly formulaCount: number
  readonly ignoredPresentationRows: number
}

const TABLE_GROUPS: Readonly<Record<string, ImportGroup>> = Object.freeze({
  CPSealProgress: 'personal',
  CPPlaythroughContext: 'personal',
  CPCharacters: 'personal',
  CPCharacterMastery: 'personal',
  CPLearnedPassives: 'personal',
  CPLoadouts: 'personal',
  CPInventory: 'personal',
  CPModOverrides: 'personal',
  CPConflicts: 'mixed',
  CPPlannerRules: 'mixed',
  CPSources: 'mixed',
})

function getRequiredFile(files: ReadonlyMap<string, Uint8Array>, path: string): Uint8Array {
  const file = files.get(path)
  if (!file) {
    throw new AppDataError('schema-mismatch', 'The XLSX package is missing a required part', {
      recoverable: true,
      details: { path },
    })
  }
  return file
}

function parseRelationships(
  files: ReadonlyMap<string, Uint8Array>,
  ownerPart: string,
): ReadonlyMap<string, string> {
  const path = relationshipPartPath(ownerPart)
  const document = parseXml(getRequiredFile(files, path), path, 'Relationships')
  if (document.documentElement.namespaceURI !== PACKAGE_REL_NS) {
    throw new AppDataError('invalid-xml', `${path} has an unexpected namespace`, { recoverable: true })
  }
  const relationships = new Map<string, string>()
  for (const relationship of elements(document, PACKAGE_REL_NS, 'Relationship')) {
    const id = relationship.getAttribute('Id')
    const target = relationship.getAttribute('Target')
    if (!id || !target || relationships.has(id)) {
      throw new AppDataError('schema-mismatch', `${path} contains an invalid relationship`, { recoverable: true })
    }
    if (relationship.getAttribute('TargetMode')?.toLowerCase() === 'external') {
      throw new AppDataError('unsafe-archive', 'External OOXML relationships are not allowed', {
        recoverable: true,
        details: { ownerPart, id },
      })
    }
    relationships.set(id, resolvePackageTarget(ownerPart, target))
  }
  return relationships
}

function rejectExternalPackageRelationships(files: ReadonlyMap<string, Uint8Array>): void {
  for (const [path, bytes] of files) {
    if (!path.endsWith('.rels')) continue
    const document = parseXml(bytes, path, 'Relationships')
    if (document.documentElement.namespaceURI !== PACKAGE_REL_NS) {
      throw new AppDataError('invalid-xml', `${path} has an unexpected namespace`, { recoverable: true })
    }
    const external = elements(document, PACKAGE_REL_NS, 'Relationship').find(
      (relationship) => relationship.getAttribute('TargetMode')?.toLocaleLowerCase() === 'external',
    )
    if (external) {
      throw new AppDataError('unsafe-archive', 'External OOXML relationships are not allowed', {
        recoverable: true,
        details: { path, id: external.getAttribute('Id') ?? undefined },
      })
    }
  }
}

function workbookPart(files: ReadonlyMap<string, Uint8Array>): string {
  const document = parseXml(getRequiredFile(files, '[Content_Types].xml'), '[Content_Types].xml', 'Types')
  if (document.documentElement.namespaceURI !== CONTENT_TYPE_NS) {
    throw new AppDataError('invalid-xml', 'The content-types part has an unexpected namespace', { recoverable: true })
  }
  const rootRelationshipsPath = '_rels/.rels'
  const rootRelationshipsDocument = parseXml(
    getRequiredFile(files, rootRelationshipsPath),
    rootRelationshipsPath,
    'Relationships',
  )
  const officeRelationships = elements(rootRelationshipsDocument, PACKAGE_REL_NS, 'Relationship').filter(
    (relationship) => relationship.getAttribute('Type')?.endsWith('/officeDocument'),
  )
  if (officeRelationships.length !== 1) {
    throw new AppDataError('schema-mismatch', 'The XLSX package must contain one root workbook relationship', {
      recoverable: true,
    })
  }
  const officeRelationship = officeRelationships[0]
  if (!officeRelationship || officeRelationship.getAttribute('TargetMode')?.toLowerCase() === 'external') {
    throw new AppDataError('unsafe-archive', 'The XLSX workbook relationship must be internal', {
      recoverable: true,
    })
  }
  const target = officeRelationship.getAttribute('Target')
  if (!target) throw new AppDataError('schema-mismatch', 'The workbook relationship has no target', { recoverable: true })
  const candidate = resolvePackageTarget('', target)
  const overrides = new Map(
    elements(document, CONTENT_TYPE_NS, 'Override').flatMap((entry) => {
      const part = entry.getAttribute('PartName')?.replace(/^\//, '')
      const contentType = entry.getAttribute('ContentType')
      return part && contentType ? [[part, contentType] as const] : []
    }),
  )
  const defaults = new Map(
    elements(document, CONTENT_TYPE_NS, 'Default').flatMap((entry) => {
      const extension = entry.getAttribute('Extension')?.toLocaleLowerCase()
      const contentType = entry.getAttribute('ContentType')
      return extension && contentType ? [[extension, contentType] as const] : []
    }),
  )
  const extension = candidate.split('.').at(-1)?.toLocaleLowerCase() ?? ''
  const contentType = overrides.get(candidate) ?? defaults.get(extension)
  if (!contentType || !XLSX_WORKBOOK_CONTENT_TYPES.has(contentType)) {
    throw new AppDataError('schema-mismatch', 'The workbook part has an unsupported content type', {
      recoverable: true,
      details: { contentType },
    })
  }
  return candidate
}

function parseSharedStrings(files: ReadonlyMap<string, Uint8Array>, path?: string): readonly string[] {
  if (!path) return []
  const document = parseXml(getRequiredFile(files, path), path, 'sst')
  if (document.documentElement.namespaceURI !== SPREADSHEET_NS) {
    throw new AppDataError('invalid-xml', `${path} has an unexpected namespace`, { recoverable: true })
  }
  return elements(document, SPREADSHEET_NS, 'si').map((item) =>
    elements(item, SPREADSHEET_NS, 't').map((text) => text.textContent ?? '').join(''),
  )
}

function cachedCellValue(type: string | null, raw: string | undefined, sharedStrings: readonly string[]): RawXlsxCell {
  if (raw === undefined || raw === '') return { address: '', kind: 'blank' }
  if (type === 's') {
    const index = Number(raw)
    const value = Number.isInteger(index) ? sharedStrings[index] : undefined
    if (value === undefined) {
      throw new AppDataError('schema-mismatch', 'An XLSX shared-string index is invalid', { recoverable: true })
    }
    return { address: '', kind: 'string', raw, value }
  }
  if (type === 'b') {
    if (raw !== '0' && raw !== '1') {
      throw new AppDataError('schema-mismatch', 'An XLSX boolean cell is invalid', { recoverable: true })
    }
    return { address: '', kind: 'boolean', raw, value: raw === '1' }
  }
  if (type === 'e') return { address: '', kind: 'error', raw, value: raw }
  if (type === 'd') return { address: '', kind: 'date', raw, value: raw }
  if (type === 'str') return { address: '', kind: 'string', raw, value: raw }
  const value = Number(raw)
  if (!Number.isFinite(value)) {
    throw new AppDataError('schema-mismatch', 'An XLSX numeric cell is invalid', { recoverable: true })
  }
  return { address: '', kind: 'number', raw, value }
}

function parseCell(cell: Element, sharedStrings: readonly string[]): RawXlsxCell {
  const address = cell.getAttribute('r')
  if (!address || !/^[A-Z]+[1-9][0-9]*$/.test(address)) {
    throw new AppDataError('schema-mismatch', 'An XLSX cell address is invalid', { recoverable: true })
  }
  const type = cell.getAttribute('t')
  // Formula text stays inert and distinct from its cached value; neither is proof of a freshly calculated result
  const formula = firstElement(cell, SPREADSHEET_NS, 'f')?.textContent ?? undefined
  if (type === 'inlineStr') {
    const value = elements(cell, SPREADSHEET_NS, 't').map((text) => text.textContent ?? '').join('')
    if (formula !== undefined) {
      return { address, kind: 'formula', formula, raw: value, value, cachedKind: 'string' }
    }
    return value.length === 0
      ? { address, kind: 'blank' }
      : { address, kind: 'string', raw: value, value }
  }
  const raw = firstElement(cell, SPREADSHEET_NS, 'v')?.textContent ?? undefined
  const cached = cachedCellValue(type, raw, sharedStrings)
  if (formula !== undefined) {
    return {
      address,
      kind: 'formula',
      formula,
      raw: cached.raw,
      value: cached.value,
      cachedKind: cached.kind as Exclude<RawCellKind, 'formula'>,
    }
  }
  return { ...cached, address }
}

function columnNumber(reference: string): number {
  const match = /^([A-Z]+)[1-9][0-9]*$/.exec(reference)
  if (!match?.[1]) throw new AppDataError('schema-mismatch', 'An XLSX reference is invalid', { recoverable: true })
  let result = 0
  for (const character of match[1]) {
    result = result * 26 + character.charCodeAt(0) - 64
    if (!Number.isSafeInteger(result) || result > MAX_TABLE_COLUMNS) {
      throw new AppDataError('schema-mismatch', 'An XLSX table exceeds the column limit', {
        recoverable: true,
        details: { limit: MAX_TABLE_COLUMNS },
      })
    }
  }
  return result
}

function rowNumber(reference: string): number {
  const match = /^[A-Z]+([1-9][0-9]*)$/.exec(reference)
  if (!match?.[1]) throw new AppDataError('schema-mismatch', 'An XLSX reference is invalid', { recoverable: true })
  const result = Number(match[1])
  if (!Number.isSafeInteger(result) || result > MAX_TABLE_ROWS) {
    throw new AppDataError('schema-mismatch', 'An XLSX table exceeds the row limit', {
      recoverable: true,
      details: { limit: MAX_TABLE_ROWS },
    })
  }
  return result
}

function parseRange(reference: string): { firstColumn: number; firstRow: number; lastColumn: number; lastRow: number } {
  const [first, last, extra] = reference.split(':')
  if (!first || !last || extra) {
    throw new AppDataError('schema-mismatch', 'An XLSX table range is invalid', { recoverable: true })
  }
  const range = {
    firstColumn: columnNumber(first),
    firstRow: rowNumber(first),
    lastColumn: columnNumber(last),
    lastRow: rowNumber(last),
  }
  if (range.firstColumn > range.lastColumn || range.firstRow >= range.lastRow) {
    throw new AppDataError('schema-mismatch', 'An XLSX table range is invalid', { recoverable: true })
  }
  const width = range.lastColumn - range.firstColumn + 1
  const dataRows = range.lastRow - range.firstRow
  if (width > MAX_TABLE_COLUMNS || dataRows > MAX_TABLE_ROWS || width * dataRows > MAX_TABLE_CELLS) {
    throw new AppDataError('schema-mismatch', 'An XLSX table range exceeds safe import limits', {
      recoverable: true,
      details: {
        maxRows: MAX_TABLE_ROWS,
        maxColumns: MAX_TABLE_COLUMNS,
        maxCells: MAX_TABLE_CELLS,
      },
    })
  }
  return range
}

function parseTable(
  files: ReadonlyMap<string, Uint8Array>,
  tablePath: string,
  sheetName: string,
  cells: ReadonlyMap<string, RawXlsxCell>,
): RawXlsxTable {
  const document = parseXml(getRequiredFile(files, tablePath), tablePath, 'table')
  if (document.documentElement.namespaceURI !== SPREADSHEET_NS) {
    throw new AppDataError('invalid-xml', `${tablePath} has an unexpected namespace`, { recoverable: true })
  }
  const name = document.documentElement.getAttribute('name')
  const rangeText = document.documentElement.getAttribute('ref')
  if (!name || !rangeText) {
    throw new AppDataError('schema-mismatch', 'An XLSX table is missing its name or range', { recoverable: true })
  }
  const range = parseRange(rangeText)
  const columns = elements(document, SPREADSHEET_NS, 'tableColumn').map((column) => column.getAttribute('name') ?? '')
  if (
    columns.some((column) => column.length === 0 || DANGEROUS_COLUMN_NAMES.has(column)) ||
    new Set(columns).size !== columns.length ||
    columns.length !== range.lastColumn - range.firstColumn + 1
  ) {
    throw new AppDataError('schema-mismatch', 'An XLSX table has invalid columns', {
      recoverable: true,
      details: { table: name },
    })
  }
  const rows: RawXlsxRow[] = []
  for (let row = range.firstRow + 1; row <= range.lastRow; row += 1) {
    const values: Record<string, RawXlsxCell> = Object.create(null) as Record<string, RawXlsxCell>
    let nonblank = false
    for (let column = range.firstColumn; column <= range.lastColumn; column += 1) {
      const columnName = columns[column - range.firstColumn]
      if (!columnName) continue
      const letters: string[] = []
      let value = column
      while (value > 0) {
        value -= 1
        letters.unshift(String.fromCharCode(65 + (value % 26)))
        value = Math.floor(value / 26)
      }
      const address = `${letters.join('')}${row}`
      const cell = cells.get(address) ?? { address, kind: 'blank' as const }
      values[columnName] = cell
      if (cell.kind !== 'blank') nonblank = true
    }
    if (nonblank) rows.push({ rowNumber: row, locator: `${sheetName}!${name}#${row}`, values })
  }
  return {
    sheet: sheetName,
    name,
    range: rangeText,
    columns,
    rows,
    group: TABLE_GROUPS[name] ?? 'reference',
    declaredCellCount: columns.length * (range.lastRow - range.firstRow),
  }
}

export function parseXlsx(bytes: Uint8Array): RawXlsxWorkbook {
  const { directory, files } = safeUnzip(bytes, {
    select: (entry) =>
      entry.name === '[Content_Types].xml' || entry.name.endsWith('.xml') || entry.name.endsWith('.rels'),
  })
  if (directory.entries.some((entry) => /(?:^|\/)(?:vbaProject\.bin|externalLinks)(?:\/|$)/i.test(entry.name))) {
    throw new AppDataError('unsafe-archive', 'Macros and external-link parts are not allowed in workbook imports', {
      recoverable: true,
    })
  }
  rejectExternalPackageRelationships(files)
  const workbookPath = workbookPart(files)
  const workbookDocument = parseXml(getRequiredFile(files, workbookPath), workbookPath, 'workbook')
  if (workbookDocument.documentElement.namespaceURI !== SPREADSHEET_NS) {
    throw new AppDataError('invalid-xml', 'The workbook has an unexpected namespace', { recoverable: true })
  }
  const workbookRelationships = parseRelationships(files, workbookPath)
  const sharedStringsRelationship = elements(
    parseXml(getRequiredFile(files, relationshipPartPath(workbookPath)), relationshipPartPath(workbookPath), 'Relationships'),
    PACKAGE_REL_NS,
    'Relationship',
  ).find((relationship) => relationship.getAttribute('Type')?.endsWith('/sharedStrings'))
  const sharedStringsPath = sharedStringsRelationship?.getAttribute('Id')
    ? workbookRelationships.get(sharedStringsRelationship.getAttribute('Id') as string)
    : undefined
  const sharedStrings = parseSharedStrings(files, sharedStringsPath)

  const tables: RawXlsxTable[] = []
  const sheetNames: string[] = []
  let formulaCount = 0
  let ignoredPresentationRows = 0
  let workbookTableCells = 0
  for (const sheet of elements(workbookDocument, SPREADSHEET_NS, 'sheet')) {
    const name = sheet.getAttribute('name')
    const relationshipId = sheet.getAttributeNS(DOCUMENT_REL_NS, 'id')
    if (!name || !relationshipId) {
      throw new AppDataError('schema-mismatch', 'The workbook contains an invalid sheet', { recoverable: true })
    }
    const sheetPath = workbookRelationships.get(relationshipId)
    if (!sheetPath || !sheetPath.startsWith('xl/worksheets/')) {
      throw new AppDataError('unsafe-archive', 'A workbook sheet points outside the worksheet area', {
        recoverable: true,
      })
    }
    sheetNames.push(name)
    const sheetDocument = parseXml(getRequiredFile(files, sheetPath), sheetPath, 'worksheet')
    if (sheetDocument.documentElement.namespaceURI !== SPREADSHEET_NS) {
      throw new AppDataError('invalid-xml', `${sheetPath} has an unexpected namespace`, { recoverable: true })
    }
    const cells = new Map<string, RawXlsxCell>()
    const rowNumbers = new Set<number>()
    for (const cellElement of elements(sheetDocument, SPREADSHEET_NS, 'c')) {
      const cell = parseCell(cellElement, sharedStrings)
      if (cells.has(cell.address)) {
        throw new AppDataError('schema-mismatch', 'A worksheet contains duplicate cell addresses', {
          recoverable: true,
          details: { sheet: name, address: cell.address },
        })
      }
      cells.set(cell.address, cell)
      rowNumbers.add(rowNumber(cell.address))
      if (cell.kind === 'formula') formulaCount += 1
    }
    const tableParts = elements(sheetDocument, SPREADSHEET_NS, 'tablePart')
    if (tableParts.length === 0) {
      ignoredPresentationRows += rowNumbers.size
      continue
    }
    const sheetRelationships = parseRelationships(files, sheetPath)
    for (const tablePart of tableParts) {
      const tableRelationshipId = tablePart.getAttributeNS(DOCUMENT_REL_NS, 'id')
      const tablePath = tableRelationshipId ? sheetRelationships.get(tableRelationshipId) : undefined
      if (!tablePath || !tablePath.startsWith('xl/tables/')) {
        throw new AppDataError('unsafe-archive', 'A worksheet table points outside the table area', {
          recoverable: true,
        })
      }
      const table = parseTable(files, tablePath, name, cells)
      workbookTableCells += table.declaredCellCount
      if (!Number.isSafeInteger(workbookTableCells) || workbookTableCells > MAX_WORKBOOK_TABLE_CELLS) {
        throw new AppDataError('schema-mismatch', 'The workbook contains too many table cells', {
          recoverable: true,
          details: { limit: MAX_WORKBOOK_TABLE_CELLS },
        })
      }
      tables.push(table)
    }
  }
  return { tables, sheetNames, formulaCount, ignoredPresentationRows }
}
