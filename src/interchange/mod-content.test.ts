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

  it('shares one deterministic revision across equivalent files while retaining each original', async () => {
    const left = bytes('{"ID":"synthetic-identity","Jobs":[{"ID":24,"Name":"Synthetic Class"}]}')
    const right = bytes('{"Jobs":[{"Name":"Synthetic Class","ID":24}],"ID":"synthetic-identity"}')
    const a = await previewCrystalEdit(left, 'a.json', '2026-01-01T00:00:00.000Z' as import('../domain/types').Timestamp)
    const b = await previewCrystalEdit(right, 'b.json', '2026-02-01T00:00:00.000Z' as import('../domain/types').Timestamp)
    expect(a.proposed.catalogs[0]!.legacy).toMatchObject({ contentFingerprint: await modContentFingerprint(right) })
    expect(a.proposed.catalogs[0]).toEqual(b.proposed.catalogs[0])
    expect(a.proposed.catalogs[0]).not.toHaveProperty('importedAt')
    expect(a.proposed.catalogs[0]!.id).toMatch(/^crystal-project\/imported\/ce1-[a-f0-9]{64}$/)
    expect(a.proposed.catalogs[0]!.revisionId).toMatch(/^j1-[a-f0-9]{64}-p1$/)
    expect(a.proposed.sources[0]!.digest).not.toBe(b.proposed.sources[0]!.digest)
    expect(a.proposed.sources[0]!.bytes).toEqual(left)
    expect(b.proposed.sources[0]!.bytes).toEqual(right)
  })

  it('keeps copied project IDs distinct by content without merging records', async () => {
    const a = await previewCrystalEdit(bytes('{"ID":"copied","Equipment":[{"ID":3,"Name":"First"}]}'), 'a.json')
    const b = await previewCrystalEdit(bytes('{"ID":"copied","Equipment":[{"ID":3,"Name":"Second"}]}'), 'b.json')
    expect(a.proposed.catalogs[0]!.id).toBe(b.proposed.catalogs[0]!.id)
    expect(a.proposed.catalogs[0]!.revisionId).not.toBe(b.proposed.catalogs[0]!.revisionId)
    expect(Object.values(a.proposed.catalogs[0]!.entities)[0]!.name).toBe('First')
    expect(Object.values(b.proposed.catalogs[0]!.entities)[0]!.name).toBe('Second')
  })

  it('checks imported JSON safety before scanning its tokens', () => {
    for (const source of ['{"__proto__":{}}', '[1,]', '{"x":1e10000}', '"unterminated']) expect(() => canonicalModJson(bytes(source))).toThrow()
  })
})
