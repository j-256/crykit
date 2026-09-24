import { zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { AppDataError } from './errors'
import { previewXlsx } from './normalize-xlsx'
import { parseXlsx } from './xlsx'

const text = (value: string): Uint8Array => new TextEncoder().encode(value)

interface WorkbookFixtureOptions {
  readonly tableName?: string
  readonly range?: string
  readonly columns?: readonly string[]
  readonly dataCells?: string
  readonly externalWorkbook?: boolean
  readonly unreferencedExternalRelationship?: boolean
}

function workbookFixture(options: WorkbookFixtureOptions = {}): Uint8Array {
  const tableName = options.tableName ?? 'CPClasses'
  const range = options.range ?? 'A1:C2'
  const columns = options.columns ?? ['Class', 'Class ID', 'Mastery LP']
  const dataCells = options.dataCells ?? '<c r="A2" t="s"><v>0</v></c><c r="B2" t="inlineStr"><is><t>fixture:class:one</t></is></c><c r="C2"><f>1+1</f><v>2</v></c>'
  const headerCells = columns
    .map((column, index) => `<c r="${String.fromCharCode(65 + index)}1" t="inlineStr"><is><t>${column}</t></is></c>`)
    .join('')
  const tableColumns = columns
    .map((column, index) => `<tableColumn id="${index + 1}" name="${column}"/>`)
    .join('')
  const relationshipMode = options.externalWorkbook ? ' TargetMode="External"' : ''
  const target = options.externalWorkbook ? 'https://example.invalid/workbook.xml' : '/xl/workbook.xml'
  return zipSync({
    '[Content_Types].xml': text('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>'),
    '_rels/.rels': text(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${target}"${relationshipMode}/></Relationships>`),
    'xl/workbook.xml': text('<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Classes" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': text('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="/xl/sharedStrings.xml"/></Relationships>'),
    'xl/sharedStrings.xml': text('<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1"><si><t>Fixture Class</t></si></sst>'),
    'xl/worksheets/sheet1.xml': text(`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetData><row r="1">${headerCells}</row><row r="2">${dataCells}</row></sheetData><tableParts count="1"><tablePart r:id="rIdTable"/></tableParts></worksheet>`),
    'xl/worksheets/_rels/sheet1.xml.rels': text('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdTable" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="/xl/tables/table1.xml"/></Relationships>'),
    'xl/tables/table1.xml': text(`<?xml version="1.0"?><table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="${tableName}" displayName="${tableName}" ref="${range}"><tableColumns count="${columns.length}">${tableColumns}</tableColumns></table>`),
    ...(options.unreferencedExternalRelationship ? {
      'xl/unused/_rels/unused.xml.rels': text('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="unused" Type="https://example.invalid/type" Target="https://example.invalid/data" TargetMode="External"/></Relationships>'),
    } : {}),
  })
}

describe('XLSX adapter', () => {
  it('discovers a workbook from root relationships and leaves formulas inert', async () => {
    const preview = await previewXlsx(workbookFixture(), 'synthetic.xlsx')
    const catalog = preview.proposed.catalogs[0]
    const entity = catalog?.entities['fixture:class:one']
    expect(entity?.name).toBe('Fixture Class')
    expect(entity?.fields['Mastery LP']).toMatchObject({ state: 'unknown' })
    expect(preview.warnings.some((warning) => warning.code === 'inert-formulas')).toBe(true)
  })

  it('maps explicit numeric PP and raw effect text without trusting formulas', async () => {
    const numeric = await previewXlsx(workbookFixture({
      tableName: 'CPPassives',
      range: 'A1:D2',
      columns: ['Passive', 'Passive ID', 'PP', 'Effect'],
      dataCells: '<c r="A2" t="inlineStr"><is><t>Fixture Passive</t></is></c><c r="B2" t="inlineStr"><is><t>fixture:passive</t></is></c><c r="C2"><v>4</v></c><c r="D2" t="inlineStr"><is><t>Documented effect</t></is></c>',
    }), 'synthetic.xlsx')
    expect(numeric.proposed.catalogs[0]?.entities['fixture:passive']).toMatchObject({
      rawDescription: 'Documented effect',
      ppCost: { state: 'known', value: 4 },
    })
    const formula = await previewXlsx(workbookFixture({
      tableName: 'CPPassives',
      range: 'A1:C2',
      columns: ['Passive', 'Passive ID', 'PP_cost'],
      dataCells: '<c r="A2" t="inlineStr"><is><t>Formula Passive</t></is></c><c r="B2" t="inlineStr"><is><t>fixture:formula</t></is></c><c r="C2"><f>2+2</f><v>4</v></c>',
    }), 'synthetic.xlsx')
    expect(formula.proposed.catalogs[0]?.entities['fixture:formula']?.ppCost).toMatchObject({ state: 'unknown' })
  })

  it('does not turn a styled blank template row into a record', () => {
    const workbook = parseXlsx(workbookFixture({
      tableName: 'CPCharacters',
      range: 'A1:A2',
      columns: ['Character ID'],
      dataCells: '<c r="A2" s="1"/>',
    }))
    expect(workbook.tables[0]?.rows).toHaveLength(0)
  })

  it('rejects huge table ranges before iteration', () => {
    expect(() => parseXlsx(workbookFixture({ range: 'A1:IV100000' }))).toThrowError(
      expect.objectContaining({ code: 'schema-mismatch' }),
    )
  })

  it('rejects duplicate and dangerous table columns', () => {
    expect(() => parseXlsx(workbookFixture({
      range: 'A1:B2',
      columns: ['Class', 'Class'],
      dataCells: '<c r="A2" t="inlineStr"><is><t>One</t></is></c>',
    }))).toThrow(AppDataError)
    expect(() => parseXlsx(workbookFixture({
      range: 'A1:A2',
      columns: ['__proto__'],
      dataCells: '<c r="A2" t="inlineStr"><is><t>One</t></is></c>',
    }))).toThrow(AppDataError)
  })

  it('rejects external workbook relationships', () => {
    expect(() => parseXlsx(workbookFixture({ externalWorkbook: true }))).toThrowError(
      expect.objectContaining({ code: 'unsafe-archive' }),
    )
  })

  it('rejects external relationships in unreferenced package parts', () => {
    expect(() => parseXlsx(workbookFixture({ unreferencedExternalRelationship: true }))).toThrowError(
      expect.objectContaining({ code: 'unsafe-archive' }),
    )
  })
})
