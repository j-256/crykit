import { describe, expect, it } from 'vitest'
import { DOCUMENT_LIMITS, childAt, childCount, childSlice, formatJsonPath, nodeAtPath, objectProperty, parseDocument, replaceJsonValue } from './document'

describe('lossless inspector documents', () => {
  it('retains number lexemes, BOM, whitespace and unknown fields without numeric coercion', () => {
    const text = '\ufeff {\r\n "ID": 900719925474099312345, "Unknown": [-0, 1.2300e+400, {"__proto__": "inert"}]\r\n}  '
    const document = parseDocument(text)
    expect(document.text).toBe(text)
    expect(document.nodeCount).toBe(7)
    const id = objectProperty(document.root, 'ID')!
    expect(id.raw).toBe('900719925474099312345')
    expect(id.value).toBeUndefined()
    expect(nodeAtPath(document.root, ['Unknown', 1])?.raw).toBe('1.2300e+400')
    expect(nodeAtPath(document.root, ['Unknown', 2, '__proto__'])?.value).toBe('inert')
    expect(objectProperty(document.root, 'toString')).toBeUndefined()
    expect(nodeAtPath(document.root, ['Unknown', -1])).toBeUndefined()
    expect(nodeAtPath(document.root, ['Unknown', '0'])).toBeUndefined()
  })

  it('materializes only requested branches with stable cached children and paths', () => {
    const document = parseDocument('{"Rows":[{"ID":1,"Name":"Synthetic"}],"empty":{}}')
    expect(document.root.children).toBe(document.root.children)
    const name = nodeAtPath(document.root, ['Rows', 0, 'Name'])!
    expect(name.path).toEqual(['Rows', 0, 'Name'])
    expect(name.path).toBe(name.path)
    expect(name.children).toEqual([])
    expect(nodeAtPath(document.root, ['empty'])?.children).toEqual([])
  })

  it('keeps paths and edits correct after traversing more branches than the retained cache', () => {
    const text = JSON.stringify({ Rows: Array.from({ length: 6000 }, (_, index) => ({ ID: index, Unknown: { value: `Synthetic ${index}` } })) })
    const document = parseDocument(text)
    const target = nodeAtPath(document.root, ['Rows', 0, 'Unknown', 'value'])!
    function visit(node: typeof document.root): void {
      for (const child of node.children) visit(child)
    }
    visit(document.root)
    expect(target.path).toEqual(['Rows', 0, 'Unknown', 'value'])
    expect(nodeAtPath(document.root, target.path)?.raw).toBe('"Synthetic 0"')
    expect(replaceJsonValue(text, target.path, '"Edited"')).toBe(text.replace('"Synthetic 0"', '"Edited"'))
  })

  it('seeks within a million-wide source array without reading the full children getter', () => {
    const width = 1_000_000
    const text = '\ufeff{"wide":[' + '0,'.repeat(width - 2) + '900719925474099312345,{"unknown.key":[true,null,"Synthetic"]}]}'
    const document = parseDocument(text)
    const rejectChildren = (node: typeof document.root): void => {
      Object.defineProperty(node, 'children', { get() { throw new Error('Full children materialization is forbidden') } })
    }
    rejectChildren(document.root)
    expect(childCount(document.root)).toBe(1)
    const wide = objectProperty(document.root, 'wide')!
    rejectChildren(wide)
    expect(childCount(wide)).toBe(width)
    expect(childCount(wide)).toBe(width)
    expect(childAt(wide, width - 2)?.raw).toBe('900719925474099312345')
    expect(childAt(wide, width - 2)?.value).toBeUndefined()
    expect(childAt(wide, 543_210)?.path).toEqual(['wide', 543_210])
    expect(childAt(wide, 1024)?.path).toEqual(['wide', 1024])
    const last = childAt(wide, width - 1)!
    expect(childAt(wide, width - 1)).toBe(last)
    rejectChildren(last)
    const values = objectProperty(last, 'unknown.key')!
    rejectChildren(values)
    expect(nodeAtPath(document.root, ['wide', width - 1, 'unknown.key', 2])?.value).toBe('Synthetic')
    expect(childSlice(wide, width - 2, 10).map(node => node.path)).toEqual([['wide', width - 2], ['wide', width - 1]])
    expect(childAt(wide, 0)?.raw).toBe('0')
    expect(childAt(wide, width)).toBeUndefined()
    expect(childAt(wide, -1)).toBeUndefined()
    expect(childAt(wide, 1.5)).toBeUndefined()
    expect(childSlice(wide, -1, 1)).toEqual([])
    expect(childSlice(wide, 0, 0)).toEqual([])
    expect(childSlice(wide, 0, 1.5)).toEqual([])
    expect(objectProperty(last, 'missing')).toBeUndefined()
  })

  it('preserves decoded object keys and bounded child paths after cache eviction', () => {
    const text = '{"Rows":[' + Array.from({ length: 5000 }, (_, index) => `{"ID":${index},"\\u0078.y":{"__proto__":true}}`).join(',') + ']}'
    const document = parseDocument(text)
    const rows = objectProperty(document.root, 'Rows')!
    const first = childAt(rows, 0)!
    const retained = nodeAtPath(document.root, ['Rows', 0, 'x.y', '__proto__'])!
    for (let index = 0; index < childCount(rows); index++) {
      const row = childAt(rows, index)!
      expect(objectProperty(row, 'ID')?.raw).toBe(String(index))
    }
    expect(objectProperty(document.root, 'Rows')).toBe(rows)
    expect(childAt(rows, 0)).not.toBe(first)
    expect(retained.path).toEqual(['Rows', 0, 'x.y', '__proto__'])
    expect(objectProperty(first, 'x.y')?.path).toEqual(['Rows', 0, 'x.y'])
    expect(nodeAtPath(document.root, retained.path)?.value).toBe(true)
    expect(childSlice(rows, 1023, 3).map(node => objectProperty(node, 'ID')?.raw)).toEqual(['1023', '1024', '1025'])
    expect(childCount(retained)).toBe(0)
    expect(childAt(retained, 0)).toBeUndefined()
  })

  it('keeps compatibility children consistent with bounded object and array access', () => {
    const document = parseDocument('{"empty":{},"Rows":[{"\\u0078":1,"name":"Synthetic"},false],"tail":null}')
    const rootChildren = document.root.children
    const rows = objectProperty(document.root, 'Rows')!
    expect(rootChildren.map(node => node.path)).toEqual(childSlice(document.root, 0, 10).map(node => node.path))
    const compatibleRecord = rows.children[0]
    const boundedRecord = childAt(rows, 0)!
    expect(boundedRecord.raw).toBe(compatibleRecord.raw)
    expect(boundedRecord.path).toEqual(compatibleRecord.path)
    expect(childCount(compatibleRecord)).toBe(2)
    expect(childAt(compatibleRecord, 0)?.key).toBe('x')
    expect(objectProperty(boundedRecord, 'x')?.raw).toBe(compatibleRecord.children[0].raw)
    expect(childCount(objectProperty(document.root, 'empty')!)).toBe(0)
    expect(childSlice(rows, 2, 5)).toEqual([])
    expect(document.root.children).toBe(rootChildren)
  })

  it.each([
    '', '[]', 'null', '{"x":01}', '{"x":1.}', '{"x":1e}', '{"x":+1}', '{"x":NaN}',
    '{"x":true,}', '{"x":[1,]}', '{"x": "\\q"}', '{"x": "\\u123x"}', '{"x": "unterminated}',
    '{"x": "line\nfeed"}', '{"x":1} garbage', '{"x":1,"x":2}', '{"x":1,"\\u0078":2}',
  ])('rejects malformed or ambiguous mod JSON: %s', text => {
    expect(() => parseDocument(text)).toThrow(/line \d+, column \d+/)
  })

  it('reports actionable text and nesting limits', () => {
    expect(() => parseDocument(' '.repeat(DOCUMENT_LIMITS.textLength + 1))).toThrow(/split the mod/)
    const text = '{"nested":' + '['.repeat(DOCUMENT_LIMITS.depth + 1) + '0' + ']'.repeat(DOCUMENT_LIMITS.depth + 1) + '}'
    expect(() => parseDocument(text)).toThrow(/nesting exceeds.*flatten/)
  })

  it('bounds the number of values without retaining a full descendant tree', () => {
    const text = '{"nodes":[' + '0,'.repeat(DOCUMENT_LIMITS.nodes) + '0]}'
    expect(() => parseDocument(text)).toThrow(/values; split the mod/)
  })

  it('edits only the selected source span and preserves surrounding bytes', () => {
    const original = '\ufeff{\r\n  "Rows": [ { "ID": 900719925474099312345, "Name": "Old", "Unknown": { "x": -0 } } ]\r\n}\n'
    const changed = replaceJsonValue(original, ['Rows', 0, 'Name'], '"New \\"name\\""')
    expect(changed).toBe(original.replace('"Old"', '"New \\"name\\""'))
    expect(nodeAtPath(parseDocument(changed).root, ['Rows', 0, 'Name'])?.value).toBe('New "name"')
    expect(replaceJsonValue(original, [], '{"Replacement":123456789012345678901234567890}')).toBe('\ufeff{"Replacement":123456789012345678901234567890}\n')
    expect(() => replaceJsonValue(original, ['missing'], 'true')).toThrow(/missing value/)
    expect(() => replaceJsonValue(original, ['Rows', 0, 'Name'], '"broken')).toThrow()
    expect(() => replaceJsonValue(original, [], '[]')).toThrow(/object at its root/)
    expect(() => replaceJsonValue(original, ['Rows', 0], '{"ID":1,"ID":2}')).toThrow(/Duplicate/)
    expect(parseDocument(original).text).toBe(original)
  })

  it('formats unambiguous paths for punctuation, quotes and array positions', () => {
    expect(formatJsonPath([])).toBe('$')
    expect(formatJsonPath(['Rows', 0, 'strange.key', '"'])).toBe('$.Rows[0]["strange.key"]["\\\""]')
  })
})
