import { describe, expect, it } from 'vitest'
import { canonicalModJson, modContentFingerprint } from './mod-content'
import { previewCrystalEdit } from './crystal-edit'

const bytes = (value: string) => new TextEncoder().encode(value)

describe('mod source content identity', () => {
  it('ignores formatting, key order, equivalent number notation, and string escapes', async () => {
    const left = bytes('{"ID":"synthetic","nested":{"b":1.20,"a":"\\u0041"},"array":[1,2]}')
    const right = bytes(' { "array": [1e0, 2.0], "nested": {"a":"A", "b":12e-1}, "ID":"synthetic" } ')
    expect(await modContentFingerprint(left)).toBe(await modContentFingerprint(right))
    expect(canonicalModJson(left)).toBe('{"ID":"synthetic","array":[1e0,2e0],"nested":{"a":"A","b":12e-1}}')
  })

  it.each([
    ['{"values":[1,2]}', '{"values":[2,1]}'],
    ['{"unknown":1}', '{}'],
    ['{"unknown":null}', '{}'],
    ['{"value":false}', '{"value":0}'],
    ['{"value":9007199254740992}', '{"value":9007199254740993}'],
    ['{"value":0.10000000000000000001}', '{"value":0.1}'],
    ['{"value":-0}', '{"value":0}'],
  ])('preserves source distinctions between %s and %s', async (left, right) => {
    expect(await modContentFingerprint(bytes(left))).not.toBe(await modContentFingerprint(bytes(right)))
  })

  it('retains the original bytes and uses different catalog pins for equivalent files', async () => {
    const left = bytes('{"ID":"synthetic-identity","Jobs":[{"ID":24,"Name":"Synthetic Class"}]}')
    const right = bytes('{"Jobs":[{"Name":"Synthetic Class","ID":24}],"ID":"synthetic-identity"}')
    const a = await previewCrystalEdit(left, 'a.json')
    const b = await previewCrystalEdit(right, 'b.json')
    expect(a.proposed.catalogs[0]!.legacy).toMatchObject({ contentFingerprint: await modContentFingerprint(right) })
    expect(a.proposed.catalogs[0]!.revisionId).not.toBe(b.proposed.catalogs[0]!.revisionId)
    expect(a.proposed.catalogs[0]!.checksum).not.toBe(b.proposed.catalogs[0]!.checksum)
    expect(a.proposed.sources[0]!.bytes).toEqual(left)
    expect(b.proposed.sources[0]!.bytes).toEqual(right)
  })

  it('checks imported JSON safety before scanning its tokens', () => {
    for (const source of ['{"__proto__":{}}', '[1,]', '{"x":1e10000}', '"unterminated']) expect(() => canonicalModJson(bytes(source))).toThrow()
  })
})
