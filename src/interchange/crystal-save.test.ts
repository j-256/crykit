import { describe, expect, it } from 'vitest'
import { CRYSTAL_SAVE_LIMITS, CrystalSaveError, decodeCrystalSave, encodeCrystalSave, type BsonDocument } from './crystal-save'

const text = new TextEncoder()
const concat = (...parts: Uint8Array[]) => {
  const bytes = new Uint8Array(parts.reduce((length, part) => length + part.length, 0))
  let position = 0
  for (const part of parts) { bytes.set(part, position); position += part.length }
  return bytes
}
const byte = (...values: number[]) => new Uint8Array(values)
const int = (value: number) => { const bytes = new Uint8Array(4); new DataView(bytes.buffer).setInt32(0, value, true); return bytes }
const long = (value: bigint) => { const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigInt64(0, value, true); return bytes }
const cstring = (value: string) => concat(text.encode(value), byte(0))
const bsonString = (value: string) => concat(int(text.encode(value).length + 1), cstring(value))
const element = (type: number, key: string, value: Uint8Array) => concat(byte(type), cstring(key), value)
const bson = (...elements: Uint8Array[]) => concat(int(elements.reduce((size, value) => size + value.length, 5)), ...elements, byte(0))
const dotnetString = (value: string) => { const bytes = text.encode(value); if (bytes.length >= 128) throw Error('Test string too long'); return concat(byte(bytes.length), bytes) }

function fixture(party = bson(element(16, 'Currency', int(17))), version = 28, inverted = false, modded = false): { bytes: Uint8Array; partyOffset: number; mapOffset: number } {
  const header = concat(
    byte(inverted ? 255 - version : version), version >= 4 ? byte(0) : byte(), version >= 21 ? byte(0) : byte(), int(0), int(1), int(2), int(3), int(4),
    version >= 28 ? concat(int(2024), int(2), int(29), int(12), int(34), int(56)) : byte(),
    dotnetString('Synthetic shrine'), int(17), int(4),
    ...Array.from({ length: 4 }, (_, index) => concat(byte(index === 3 ? 0 : 1), dotnetString(`Example ${index}`), int(5), int(0), int(0))),
    version >= 12 ? int(2) : byte(), version >= 17 ? byte(0) : byte(),
    version >= 14 ? concat(int(5), int(9), int(17)) : version >= 12 ? byte(1, 0, 1, 0, 0, 0, 0) : byte(),
    version >= 16 ? int(3) : byte(),
    version >= 24 ? modded ? concat(byte(1), int(1), dotnetString('sample'), dotnetString('Sample mod'), dotnetString('1.0'), version >= 25 ? long(-1n) : byte()) : concat(byte(0), int(0)) : byte(),
    version >= 25 ? modded ? concat(int(1), dotnetString('sample'), ...Array.from({ length: version >= 27 ? 15 : 14 }, (_, index) => concat(int(1), int(index), int(index + 100)))) : int(0) : byte(),
  )
  const members = Array.from({ length: 4 }, (_, index) => bson(element(2, 'Name', bsonString(`Example ${index}`))))
  const maps = concat(int(1), int(3), int(-20), int(7), int(3), int(3), int(2), byte(0x45, 0x01))
  const combat = concat(int(2), int(3), byte(0x82, 0x00, 0xff), int(2), byte(0xfe, 0xfd))
  const bytes = concat(header, party, ...members, maps, combat)
  for (let index = 1 + Number(version >= 4) + Number(version >= 21); index < bytes.length; index++) bytes[index] ^= 0xff
  return { bytes, partyOffset: header.length, mapOffset: header.length + party.length + members.reduce((length, member) => length + member.length, 0) }
}

function decodedMutation(bytes: Uint8Array, offset: number, replacement: Uint8Array): Uint8Array {
  const copy = bytes.slice()
  for (let index = 0; index < replacement.length; index++) copy[offset + index] = replacement[index] ^ (offset + index >= 3 ? 0xff : 0)
  return copy
}

describe('Crystal Project versioned save codec', () => {
  it.each(Array.from({ length: 29 }, (_, version) => version))('reads independent format %i framing and preserves the layout after editing', version => {
    const { bytes } = fixture(undefined, version)
    const save = decodeCrystalSave(bytes)
    expect(save.header.version).toBe(version)
    expect(save.header.lastUpdated === null).toBe(version < 28)
    expect(save.header.difficultyId).toBe(version >= 12 ? 2 : -1)
    expect(save.header.assistFlags).toBe(version >= 12 ? 5 : 0)
    expect(save.header.challengeFlags).toBe(version >= 14 ? 9 : 0)
    expect(save.header.randomizerFlags).toBe(version >= 14 ? 17 : 0)
    expect(save.header.newGamePlusCount).toBe(version >= 16 ? 3 : 0)
    expect(encodeCrystalSave(save)).toEqual(bytes)
    save.header.currencyAmount = 1234
    save.party.value.Currency = { type: 'int32', value: 1234 }
    const edited = decodeCrystalSave(encodeCrystalSave(save))
    expect(edited.header.version).toBe(version)
    expect(edited.header.currencyAmount).toBe(1234)
    expect(edited.maps).toEqual(save.maps)
    expect(edited.combatBytes).toEqual(save.combatBytes)
  })

  it.each([1, 2, 3])('preserves the inverted format %i byte on changed exports', version => {
    const { bytes } = fixture(undefined, version, true)
    const save = decodeCrystalSave(bytes)
    expect(save.header).toMatchObject({ version, invertedVersion: true })
    expect(encodeCrystalSave(save)).toEqual(bytes)
    save.header.members[0].name = 'Changed'
    save.members[0].value.Name = { type: 'string', value: 'Changed' }
    const output = encodeCrystalSave(save)
    expect(output[0]).toBe(255 - version)
    expect(decodeCrystalSave(output).header.members[0].name).toBe('Changed')
  })

  it.each([24, 25, 26, 27, 28])('retains format %i mod metadata and version-specific mapping groups', version => {
    const { bytes } = fixture(undefined, version, false, true)
    const save = decodeCrystalSave(bytes)
    expect(save.header.mods[0]).toEqual({ id: 'sample', title: 'Sample mod', version: '1.0', steamWorkshopFileId: version >= 25 ? (1n << 64n) - 1n : 0n })
    expect(save.header.modIdMaps).toHaveLength(version >= 25 ? 1 : 0)
    if (version >= 25) {
      expect(save.header.modIdMaps[0].groups.animations).toEqual(version >= 27 ? [{ originalId: 1, newId: 101 }] : [])
      expect(save.header.modIdMaps[0].groups.entities).toEqual([{ originalId: version >= 27 ? 14 : 13, newId: version >= 27 ? 114 : 113 }])
    }
    expect(encodeCrystalSave(save)).toEqual(bytes)
  })

  it('decodes independently constructed sections and exports an identical unopened save', () => {
    const { bytes } = fixture()
    const save = decodeCrystalSave(bytes)
    expect(save.header.homePointName).toBe('Synthetic shrine')
    expect(save.header.members[3]).toEqual({ isPresent: false, name: 'Example 3', level: 5, genderId: 0, jobId: 0 })
    expect(save.header.lastUpdated).toEqual({ year: 2024, month: 2, day: 29, hour: 12, minute: 34, second: 56 })
    expect(save.maps).toEqual([{ id: 3, originX: -20, originY: 7, lengthX: 3, lengthY: 3, data: byte(0x45, 0x01) }])
    expect(encodeCrystalSave(save)).toEqual(bytes)
    expect(encodeCrystalSave(structuredClone(save))).toEqual(bytes)
    bytes.fill(0)
    expect(save.originalBytes[0]).toBe(28)
  })

  it('retains numeric widths, dates, numeric key order, NaN payloads, and prototype-shaped fields', () => {
    const nanBytes = byte(0x33, 0x22, 0x11, 0, 0, 0, 0xf8, 0x7f)
    const doc = bson(
      element(16, '8', int(9)), element(16, '2', int(3)),
      element(18, 'wide', long(9_007_199_254_740_993n)),
      element(9, 'date', long(-62_135_596_800_000n)),
      element(1, 'nan', nanBytes),
      element(3, '__proto__', bson(element(8, 'polluted', byte(1)))),
      element(2, 'constructor', bsonString('\ufeffKeeps BOM')),
    )
    const { bytes } = fixture(doc)
    const save = decodeCrystalSave(bytes)
    expect(Object.getPrototypeOf(save.party.value)).toBeNull()
    expect(Object.prototype).not.toHaveProperty('polluted')
    expect(save.party.value.wide).toEqual({ type: 'int64', value: 9_007_199_254_740_993n })
    expect(save.party.value.date).toEqual({ type: 'datetime', value: -62_135_596_800_000n })
    expect(save.party.value.constructor).toEqual({ type: 'string', value: '\ufeffKeeps BOM' })
    expect(encodeCrystalSave(structuredClone(save))).toEqual(bytes)
  })

  it('keeps opaque BSON values as inert bytes while validating their framing', () => {
    const code = 'throw Error("Never evaluate imported code")'
    const scope = concat(bsonString(code), bson(element(16, 'value', int(2))))
    const payloads = [
      element(5, 'binary', concat(int(3), byte(0), byte(2, 4, 6))),
      element(5, 'oldBinary', concat(int(6), byte(2), int(2), byte(1, 2))),
      element(6, 'undefined', byte()), element(7, 'objectId', byte(...Array.from({ length: 12 }, (_, index) => index))),
      element(11, 'regex', concat(cstring('a+'), cstring('i'))),
      element(12, 'reference', concat(bsonString('collection'), new Uint8Array(12))),
      element(13, 'code', bsonString(code)), element(14, 'symbol', bsonString('token')),
      element(15, 'scope', concat(int(scope.length + 4), scope)),
      element(17, 'timestamp', long(123n)), element(19, 'decimal', new Uint8Array(16)),
      element(127, 'max', byte()), element(255, 'min', byte()),
    ]
    const { bytes } = fixture(bson(...payloads))
    const save = decodeCrystalSave(bytes)
    expect(Object.values(save.party.value).every(value => value.type === 'opaque')).toBe(true)
    expect(encodeCrystalSave(save)).toEqual(bytes)
  })

  it('changes selected values without rewriting unrelated BSON fields, maps, or combat history', () => {
    const { bytes } = fixture(bson(element(3, 'Unknown', bson(element(18, 'Wide', long(MAX_SAFE_LONG)))), element(16, 'Currency', int(17))))
    const save = decodeCrystalSave(bytes)
    const original = structuredClone(save)
    save.header.currencyAmount = 999
    save.header.members[0].name = 'Renamed adventurer'
    save.party.value.Currency = { type: 'int32', value: 999 }
    save.members[0].value.Name = { type: 'string', value: 'Renamed adventurer' }
    const output = decodeCrystalSave(encodeCrystalSave(save))
    expect(output.header.currencyAmount).toBe(999)
    expect(output.members[0].value.Name).toEqual({ type: 'string', value: 'Renamed adventurer' })
    expect(output.party.value.Unknown).toEqual(original.party.value.Unknown)
    expect(output.maps).toEqual(original.maps)
    expect(output.combatBytes).toEqual(original.combatBytes)
    expect(save.originalBytes).toEqual(bytes)
  })

  it('round-trips mod headers and every mapping group with exact workshop IDs', () => {
    const save = decodeCrystalSave(fixture().bytes)
    save.header.isModded = true
    save.header.mods = [{ id: 'synthetic-mod', title: 'Synthetic mod', version: '1', steamWorkshopFileId: (1n << 64n) - 1n }]
    save.header.modIdMaps = [{ modId: 'synthetic-mod', groups: { jobs: [{ originalId: 24, newId: 27 }], entities: [{ originalId: 5, newId: 123 }] } }]
    const bytes = encodeCrystalSave(save)
    const result = decodeCrystalSave(bytes)
    expect(result.header.mods).toEqual(save.header.mods)
    expect(result.header.modIdMaps[0].groups.jobs).toEqual([{ originalId: 24, newId: 27 }])
    expect(result.header.modIdMaps[0].groups.entities).toEqual([{ originalId: 5, newId: 123 }])
    expect(encodeCrystalSave(result)).toEqual(bytes)
  })

  it('rejects unsupported versions, malformed UTF-8, duplicate keys, and nonsequential arrays', () => {
    const { bytes } = fixture()
    expect(() => decodeCrystalSave(decodedMutation(bytes, 0, byte(29)))).toThrow('Unsupported save format 29')
    expect(() => decodeCrystalSave(decodedMutation(bytes, 1, byte(2)))).toThrow('boolean')
    expect(() => decodeCrystalSave(fixture(bson(element(2, 'bad', concat(int(2), byte(0xff, 0))))).bytes)).toThrow('UTF-8')
    expect(() => decodeCrystalSave(fixture(bson(element(16, 'x', int(1)), element(16, 'x', int(2)))).bytes)).toThrow('Duplicate')
    expect(() => decodeCrystalSave(fixture(bson(element(4, 'array', bson(element(16, '1', int(2)))))).bytes)).toThrow('array index')
    expect(() => decodeCrystalSave(fixture(bson(element(20, 'unknown-type', byte()))).bytes)).toThrow('Unsupported BSON type')
  })

  it('rejects truncated sections, inconsistent nested lengths, invalid map lengths, and trailing data', () => {
    const { bytes, partyOffset, mapOffset } = fixture()
    for (const end of [0, 2, 3, 30, partyOffset + 2, mapOffset + 10, bytes.length - 1]) expect(() => decodeCrystalSave(bytes.slice(0, end))).toThrow(CrystalSaveError)
    expect(() => decodeCrystalSave(decodedMutation(bytes, partyOffset, int(0x7fffffff)))).toThrow('document length')
    expect(() => decodeCrystalSave(decodedMutation(bytes, mapOffset + 24, int(1)))).toThrow('bitmap length')
    expect(() => decodeCrystalSave(concat(bytes, byte(0)))).toThrow('trailing')
    const invalidChild = bson(element(3, 'nested', concat(int(100), byte(0))))
    expect(() => decodeCrystalSave(fixture(invalidChild).bytes)).toThrow('document length')
  })

  it('enforces input and output complexity and numeric bounds', () => {
    expect(() => decodeCrystalSave(new Uint8Array(CRYSTAL_SAVE_LIMITS.maxFileBytes + 1))).toThrow('size limit')
    let nested = bson()
    for (let index = 0; index < CRYSTAL_SAVE_LIMITS.maxDepth + 1; index++) nested = bson(element(3, 'child', nested))
    expect(() => decodeCrystalSave(fixture(nested).bytes)).toThrow('complexity')
    const save = decodeCrystalSave(fixture().bytes)
    save.party.value.Currency = { type: 'int32', value: 2 ** 31 }
    expect(() => encodeCrystalSave(save)).toThrow('out-of-range')
    save.party.value.Currency = { type: 'int64', value: 1n << 63n }
    expect(() => encodeCrystalSave(save)).toThrow('64-bit integer')
    save.party.value.Currency = { type: 'string', value: '\ud800' }
    expect(() => encodeCrystalSave(save)).toThrow('invalid Unicode')
    const cycle: BsonDocument = { type: 'document', value: {} }
    cycle.value.cycle = cycle
    save.party = cycle
    expect(() => encodeCrystalSave(save)).toThrow('complexity')
  })

  it('rejects metadata that would be silently lost in a legacy layout', () => {
    const save = decodeCrystalSave(fixture(undefined, 24).bytes)
    save.header.mods = [{ id: 'sample', title: 'Sample', version: '1', steamWorkshopFileId: 999n }]
    expect(() => encodeCrystalSave(save)).toThrow('cannot be represented')
    const older = decodeCrystalSave(fixture(undefined, 3).bytes)
    older.header.isModded = true
    expect(() => encodeCrystalSave(older)).toThrow('cannot be represented')
  })

  it('rejects malformed date and opaque payloads before producing an export', () => {
    const save = decodeCrystalSave(fixture().bytes)
    save.header.lastUpdated!.day = 30
    expect(() => encodeCrystalSave(save)).toThrow('header')
    save.header.lastUpdated!.day = 29
    save.party.value.invalid = { type: 'opaque', bsonType: 5, value: concat(int(5), byte(0, 1)) }
    expect(() => encodeCrystalSave(save)).toThrow(CrystalSaveError)
  })
})

const MAX_SAFE_LONG = 9_223_372_036_854_775_000n
