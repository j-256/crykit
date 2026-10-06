export const CRYSTAL_SAVE_VERSION = 28
export const CRYSTAL_SAVE_MIN_VERSION = 0
export function crystalSaveVersion(storedVersion: number): number {
  const legacyVersion = 255 - storedVersion
  return legacyVersion >= 1 && legacyVersion <= 3 ? legacyVersion : storedVersion
}
export function isSupportedCrystalSaveVersion(version: number): boolean {
  return Number.isInteger(version) && version >= CRYSTAL_SAVE_MIN_VERSION && version <= CRYSTAL_SAVE_VERSION
}
export const CRYSTAL_SAVE_LIMITS = Object.freeze({
  maxFileBytes: 64 * 1024 * 1024,
  maxStringBytes: 4 * 1024 * 1024,
  maxDocumentBytes: 32 * 1024 * 1024,
  maxDepth: 64,
  maxNodes: 1_000_000,
  maxMaps: 4096,
  maxMods: 4096,
  maxModMappings: 1_000_000,
})

const MEMBER_COUNT = 4
const FORMAT = Object.freeze({ demo: 4, difficulty: 12, flags: 14, newGamePlus: 16, patchMode: 17, hardcore: 21, mods: 24, modIds: 25, animationIds: 27, savedDate: 28 })
function prefixBytes(version: number): number { return 1 + Number(version >= FORMAT.demo) + Number(version >= FORMAT.hardcore) }
const MIN_DOCUMENT_BYTES = 5
const MAX_INT32 = 0x7fffffff
const MIN_INT32 = -0x80000000
const MAX_INT64 = (1n << 63n) - 1n
const MIN_INT64 = -(1n << 63n)
const MAX_UINT64 = (1n << 64n) - 1n
const MOD_GROUPS = ['abilities', 'animations', 'biomes', 'difficulties', 'equipment', 'genders', 'items', 'jobs', 'monsters', 'passives', 'recipes', 'sparks', 'statuses', 'troops', 'entities'] as const
const utf8 = new TextEncoder()
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export type BsonDocument = { type: 'document'; value: Record<string, BsonValue>; keys?: string[] }
export type BsonValue = BsonDocument
  | { type: 'array'; value: BsonValue[] }
  | { type: 'int32'; value: number }
  | { type: 'double'; value: number; raw?: Uint8Array }
  | { type: 'int64' | 'datetime'; value: bigint }
  | { type: 'string'; value: string }
  | { type: 'boolean'; value: boolean }
  | { type: 'null' }
  | { type: 'opaque'; bsonType: number; value: Uint8Array }

export interface CrystalSaveHeaderMember {
  isPresent: boolean
  name: string
  level: number
  genderId: number
  jobId: number
}

export interface CrystalSaveHeader {
  version: number
  invertedVersion?: boolean
  isDemo: boolean
  isHardcoreDefeat: boolean
  playTime: { days: number; hours: number; minutes: number; seconds: number; milliseconds: number }
  lastUpdated: { year: number; month: number; day: number; hour: number; minute: number; second: number } | null
  homePointName: string
  currencyAmount: number
  members: CrystalSaveHeaderMember[]
  difficultyId: number
  patchMode: number
  assistFlags: number
  challengeFlags: number
  randomizerFlags: number
  newGamePlusCount: number
  isModded: boolean
  mods: { id: string; title: string; version: string; steamWorkshopFileId: bigint }[]
  modIdMaps: { modId: string; groups: Record<string, { originalId: number; newId: number }[]> }[]
}

export interface CrystalSaveMap {
  id: number
  originX: number
  originY: number
  lengthX: number
  lengthY: number
  data: Uint8Array
}

export interface CrystalSave {
  originalBytes: Uint8Array
  header: CrystalSaveHeader
  party: BsonDocument
  members: BsonDocument[]
  maps: CrystalSaveMap[]
  combatBytes: Uint8Array
}

export class CrystalSaveError extends Error {
  readonly offset: number | null

  constructor(message: string, offset: number | null = null) {
    super(offset === null ? message : `${message} at byte ${offset}`)
    this.name = 'CrystalSaveError'
    this.offset = offset
  }
}

function assertInteger(value: number, min = MIN_INT32, max = MAX_INT32): void {
  if (!Number.isInteger(value) || value < min || value > max) throw new CrystalSaveError('Save contains an out-of-range integer')
}

function validDate(value: CrystalSaveHeader['lastUpdated']): boolean {
  if (!value) return false
  const { year, month, day, hour, minute, second } = value
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return year >= 1 && year <= 9999 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] && hour >= 0 && hour < 24 && minute >= 0 && minute < 60 && second >= 0 && second < 60
}

class Reader {
  readonly bytes: Uint8Array
  readonly view: DataView
  position = 0
  nodes = 0

  constructor(bytes: Uint8Array) {
    this.bytes = bytes
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  fail(message: string): never { throw new CrystalSaveError(message, this.position) }

  require(length: number, end = this.bytes.length): void {
    if (!Number.isSafeInteger(length) || length < 0 || this.position + length > end || end > this.bytes.length) this.fail('Truncated or invalid save section')
  }

  take(length: number, end = this.bytes.length): Uint8Array {
    this.require(length, end)
    const value = this.bytes.slice(this.position, this.position + length)
    this.position += length
    return value
  }

  byte(end = this.bytes.length): number { this.require(1, end); return this.bytes[this.position++] }

  int32(end = this.bytes.length): number {
    this.require(4, end)
    const value = this.view.getInt32(this.position, true)
    this.position += 4
    return value
  }

  int64(unsigned = false, end = this.bytes.length): bigint {
    this.require(8, end)
    const value = unsigned ? this.view.getBigUint64(this.position, true) : this.view.getBigInt64(this.position, true)
    this.position += 8
    return value
  }

  boolean(end = this.bytes.length): boolean {
    const value = this.byte(end)
    if (value !== 0 && value !== 1) this.fail('Invalid boolean encoding')
    return value === 1
  }

  count(limit: number, label: string, minimumBytes = 0): number {
    const value = this.int32()
    if (value < 0 || value > limit || value * minimumBytes > this.bytes.length - this.position) this.fail(`Invalid ${label} count`)
    return value
  }

  text(length: number, end = this.bytes.length): string {
    if (length > CRYSTAL_SAVE_LIMITS.maxStringBytes) this.fail('Save string exceeds the size limit')
    const bytes = this.take(length, end)
    try { return strictUtf8.decode(bytes) } catch { return this.fail('Invalid UTF-8 in save string') }
  }

  string(): string {
    let length = 0
    for (let index = 0; index < 5; index++) {
      const next = this.byte()
      if (index === 4 && next > 7) this.fail('Invalid string length prefix')
      length += (next & 0x7f) * 2 ** (index * 7)
      if ((next & 0x80) === 0) {
        if (index > 0 && next === 0) this.fail('Noncanonical string length prefix')
        return this.text(length)
      }
    }
    return this.fail('Invalid string length prefix')
  }

  cstring(end: number): string {
    const start = this.position
    while (this.position < end && this.bytes[this.position] !== 0) {
      if (this.position - start >= CRYSTAL_SAVE_LIMITS.maxStringBytes) this.fail('Save string exceeds the size limit')
      this.position++
    }
    if (this.position === end) this.fail('Unterminated BSON key')
    const length = this.position - start
    this.position = start
    const value = this.text(length, end)
    this.byte(end)
    return value
  }

  bsonString(end: number): string {
    const length = this.int32(end)
    if (length < 1) this.fail('Invalid BSON string length')
    const value = this.text(length - 1, end)
    if (this.byte(end) !== 0) this.fail('Unterminated BSON string')
    return value
  }

  document(depth = 0, outerEnd = this.bytes.length, array = false): BsonDocument | Extract<BsonValue, { type: 'array' }> {
    if (depth > CRYSTAL_SAVE_LIMITS.maxDepth || ++this.nodes > CRYSTAL_SAVE_LIMITS.maxNodes) this.fail('Save BSON exceeds the complexity limit')
    const start = this.position
    const length = this.int32(outerEnd)
    if (length < MIN_DOCUMENT_BYTES || length > CRYSTAL_SAVE_LIMITS.maxDocumentBytes || start + length > outerEnd) this.fail('Invalid BSON document length')
    const end = start + length
    const value: Record<string, BsonValue> = Object.create(null)
    const keys: string[] = []
    const values: BsonValue[] = []
    while (this.position < end - 1) {
      const type = this.byte(end - 1)
      if (type === 0) this.fail('Unexpected BSON document terminator')
      const key = this.cstring(end - 1)
      if (Object.hasOwn(value, key)) this.fail('Duplicate BSON document key')
      if (array && key !== String(values.length)) this.fail('Invalid BSON array index')
      const child = this.value(type, depth + 1, end - 1)
      value[key] = child
      keys.push(key)
      if (array) values.push(child)
    }
    if (this.position !== end - 1 || this.byte(end) !== 0) this.fail('Invalid BSON document terminator')
    return array ? { type: 'array', value: values } : { type: 'document', value, keys }
  }

  value(type: number, depth: number, end: number): BsonValue {
    if (++this.nodes > CRYSTAL_SAVE_LIMITS.maxNodes || depth > CRYSTAL_SAVE_LIMITS.maxDepth) this.fail('Save BSON exceeds the complexity limit')
    const start = this.position
    switch (type) {
      case 1: {
        const raw = this.take(8, end)
        return { type: 'double', value: new DataView(raw.buffer).getFloat64(0, true), raw }
      }
      case 2: return { type: 'string', value: this.bsonString(end) }
      case 3: return this.document(depth, end)
      case 4: return this.document(depth, end, true)
      case 8: return { type: 'boolean', value: this.boolean(end) }
      case 9: return { type: 'datetime', value: this.int64(false, end) }
      case 10: return { type: 'null' }
      case 16: return { type: 'int32', value: this.int32(end) }
      case 18: return { type: 'int64', value: this.int64(false, end) }
      case 5: {
        const length = this.int32(end)
        const subtype = this.byte(end)
        this.require(length, end)
        if (subtype === 2) {
          if (length < 4 || this.int32(end) !== length - 4) this.fail('Invalid BSON binary length')
          this.take(length - 4, end)
        } else this.take(length, end)
        break
      }
      case 6: case 127: case 255: break
      case 7: this.take(12, end); break
      case 11: this.cstring(end); this.cstring(end); break
      case 12: this.bsonString(end); this.take(12, end); break
      case 13: case 14: this.bsonString(end); break
      case 15: {
        const length = this.int32(end)
        if (length < 14 || start + length > end) this.fail('Invalid BSON code scope length')
        this.bsonString(start + length)
        this.document(depth, start + length)
        if (this.position !== start + length) this.fail('Invalid BSON code scope boundary')
        break
      }
      case 17: this.take(8, end); break
      case 19: this.take(16, end); break
      default: return this.fail(`Unsupported BSON type ${type}`)
    }
    return { type: 'opaque', bsonType: type, value: this.bytes.slice(start, this.position) }
  }
}

class Writer {
  private bytes = new Uint8Array(1024)
  position = 0
  nodes = 0

  private ensure(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0 || this.position + length > CRYSTAL_SAVE_LIMITS.maxFileBytes) throw new CrystalSaveError('Save exceeds the file size limit')
    if (this.position + length <= this.bytes.length) return
    const next = new Uint8Array(Math.min(CRYSTAL_SAVE_LIMITS.maxFileBytes, Math.max(this.bytes.length * 2, this.position + length)))
    next.set(this.bytes)
    this.bytes = next
  }

  byte(value: number): void { assertInteger(value, 0, 255); this.ensure(1); this.bytes[this.position++] = value }
  boolean(value: boolean): void {
    if (typeof value !== 'boolean') throw new CrystalSaveError('Save contains an invalid boolean')
    this.byte(value ? 1 : 0)
  }
  append(value: Uint8Array): void { this.ensure(value.length); this.bytes.set(value, this.position); this.position += value.length }
  int32(value: number): void { assertInteger(value); this.ensure(4); new DataView(this.bytes.buffer).setInt32(this.position, value, true); this.position += 4 }
  int64(value: bigint, unsigned = false): void {
    if (typeof value !== 'bigint' || value < (unsigned ? 0n : MIN_INT64) || value > (unsigned ? MAX_UINT64 : MAX_INT64)) throw new CrystalSaveError('Save contains an out-of-range 64-bit integer')
    this.ensure(8)
    const view = new DataView(this.bytes.buffer)
    if (unsigned) view.setBigUint64(this.position, value, true)
    else view.setBigInt64(this.position, value, true)
    this.position += 8
  }

  private text(value: string): Uint8Array {
    if (typeof value !== 'string' || value.length > CRYSTAL_SAVE_LIMITS.maxStringBytes) throw new CrystalSaveError('Save string exceeds the size limit')
    const bytes = utf8.encode(value)
    if (bytes.length > CRYSTAL_SAVE_LIMITS.maxStringBytes) throw new CrystalSaveError('Save string exceeds the size limit')
    if (strictUtf8.decode(bytes) !== value) throw new CrystalSaveError('Save string contains invalid Unicode')
    return bytes
  }

  string(value: string): void {
    const bytes = this.text(value)
    let length = bytes.length
    while (length >= 128) { this.byte((length % 128) | 128); length = Math.floor(length / 128) }
    this.byte(length)
    this.append(bytes)
  }

  private cstring(value: string): void {
    if (value.includes('\0')) throw new CrystalSaveError('BSON key contains a null character')
    this.append(this.text(value))
    this.byte(0)
  }

  document(document: BsonDocument | Extract<BsonValue, { type: 'array' }>, depth = 0): void {
    if (depth > CRYSTAL_SAVE_LIMITS.maxDepth || ++this.nodes > CRYSTAL_SAVE_LIMITS.maxNodes) throw new CrystalSaveError('Save BSON exceeds the complexity limit')
    const start = this.position
    this.int32(0)
    const keys = document.type === 'array' ? document.value.map((_, index) => String(index)) : [...new Set([...(document.keys ?? []).filter(key => Object.hasOwn(document.value, key)), ...Object.keys(document.value)])]
    for (const key of keys) {
      const value = document.type === 'array' ? document.value[Number(key)] : document.value[key]
      if (!value || ++this.nodes > CRYSTAL_SAVE_LIMITS.maxNodes) throw new CrystalSaveError('Save BSON exceeds the complexity limit')
      const type = value.type === 'opaque' ? value.bsonType : { double: 1, string: 2, document: 3, array: 4, boolean: 8, datetime: 9, null: 10, int32: 16, int64: 18 }[value.type]
      this.byte(type)
      this.cstring(key)
      this.value(value, depth + 1)
    }
    this.byte(0)
    if (this.position - start > CRYSTAL_SAVE_LIMITS.maxDocumentBytes) throw new CrystalSaveError('BSON document exceeds the size limit')
    new DataView(this.bytes.buffer).setInt32(start, this.position - start, true)
  }

  private value(value: BsonValue, depth: number): void {
    if (depth > CRYSTAL_SAVE_LIMITS.maxDepth) throw new CrystalSaveError('Save BSON exceeds the complexity limit')
    switch (value.type) {
      case 'document': case 'array': this.document(value, depth); break
      case 'int32': this.int32(value.value); break
      case 'int64': case 'datetime': this.int64(value.value); break
      case 'boolean': this.boolean(value.value); break
      case 'string': {
        const bytes = this.text(value.value)
        this.int32(bytes.length + 1)
        this.append(bytes)
        this.byte(0)
        break
      }
      case 'double': {
        if (typeof value.value !== 'number') throw new CrystalSaveError('Save contains an invalid floating-point value')
        if (value.raw?.length === 8 && Object.is(new DataView(value.raw.buffer, value.raw.byteOffset, 8).getFloat64(0, true), value.value)) this.append(value.raw)
        else {
          this.ensure(8)
          new DataView(this.bytes.buffer).setFloat64(this.position, value.value, true)
          this.position += 8
        }
        break
      }
      case 'opaque': this.append(value.value); break
      case 'null': break
    }
  }

  finish(): Uint8Array { return this.bytes.slice(0, this.position) }
}

function readHeader(reader: Reader): CrystalSaveHeader {
  const storedVersion = reader.byte()
  const version = crystalSaveVersion(storedVersion)
  if (!isSupportedCrystalSaveVersion(version)) reader.fail(`Unsupported save format ${version}; the native reader supports formats ${CRYSTAL_SAVE_MIN_VERSION} to ${CRYSTAL_SAVE_VERSION}`)
  const invertedVersion = storedVersion !== version
  const isDemo = version >= FORMAT.demo ? reader.boolean() : false
  const isHardcoreDefeat = version >= FORMAT.hardcore ? reader.boolean() : false
  const playTime = { days: reader.int32(), hours: reader.int32(), minutes: reader.int32(), seconds: reader.int32(), milliseconds: reader.int32() }
  const lastUpdated = version >= FORMAT.savedDate ? { year: reader.int32(), month: reader.int32(), day: reader.int32(), hour: reader.int32(), minute: reader.int32(), second: reader.int32() } : null
  if (lastUpdated && !validDate(lastUpdated)) reader.fail('Invalid save header date')
  const homePointName = reader.string()
  const currencyAmount = reader.int32()
  if (reader.int32() !== MEMBER_COUNT) reader.fail(`Save format requires ${MEMBER_COUNT} party member slots`)
  const members = Array.from({ length: MEMBER_COUNT }, () => ({ isPresent: reader.boolean(), name: reader.string(), level: reader.int32(), genderId: reader.int32(), jobId: reader.int32() }))
  const difficultyId = version >= FORMAT.difficulty ? reader.int32() : -1
  const patchMode = version >= FORMAT.patchMode ? reader.byte() : 0
  let assistFlags = 0
  if (version >= FORMAT.flags) assistFlags = reader.int32()
  else if (version >= FORMAT.difficulty) for (let bit = 0; bit < 7; bit++) if (reader.boolean()) assistFlags |= 1 << bit
  const challengeFlags = version >= FORMAT.flags ? reader.int32() : 0
  const randomizerFlags = version >= FORMAT.flags ? reader.int32() : 0
  const newGamePlusCount = version >= FORMAT.newGamePlus ? reader.int32() : 0
  const isModded = version >= FORMAT.mods ? reader.boolean() : false
  const mods = version >= FORMAT.mods ? Array.from({ length: reader.count(CRYSTAL_SAVE_LIMITS.maxMods, 'mod', version >= FORMAT.modIds ? 11 : 3) }, () => ({ id: reader.string(), title: reader.string(), version: reader.string(), steamWorkshopFileId: version >= FORMAT.modIds ? reader.int64(true) : 0n })) : []
  let totalMappings = 0
  const modIdMaps = version >= FORMAT.modIds ? Array.from({ length: reader.count(CRYSTAL_SAVE_LIMITS.maxMods, 'mod ID map', version >= FORMAT.animationIds ? 61 : 57) }, () => {
    const modId = reader.string()
    const groups: CrystalSaveHeader['modIdMaps'][number]['groups'] = Object.create(null)
    for (const group of MOD_GROUPS) {
      if (group === 'animations' && version < FORMAT.animationIds) { groups[group] = []; continue }
      const count = reader.count(CRYSTAL_SAVE_LIMITS.maxModMappings - totalMappings, 'mod mapping', 8)
      totalMappings += count
      groups[group] = Array.from({ length: count }, () => ({ originalId: reader.int32(), newId: reader.int32() }))
    }
    return { modId, groups }
  }) : []
  return { version, invertedVersion, isDemo, isHardcoreDefeat, playTime, lastUpdated, homePointName, currencyAmount, members, difficultyId, patchMode, assistFlags, challengeFlags, randomizerFlags, newGamePlusCount, isModded, mods, modIdMaps }
}

function writeHeader(writer: Writer, header: CrystalSaveHeader): void {
  const version = header.version
  if (!isSupportedCrystalSaveVersion(version) || header.members.length !== MEMBER_COUNT || (version >= FORMAT.savedDate && !validDate(header.lastUpdated)) || (header.invertedVersion && (version < 1 || version > 3))) throw new CrystalSaveError('Invalid save header')
  const unsupportedValues = [
    version < FORMAT.demo && header.isDemo,
    version < FORMAT.hardcore && header.isHardcoreDefeat,
    version < FORMAT.difficulty && header.difficultyId !== -1,
    version < FORMAT.patchMode && header.patchMode !== 0,
    version < FORMAT.flags && (header.challengeFlags !== 0 || header.randomizerFlags !== 0 || header.assistFlags > (version >= FORMAT.difficulty ? 127 : 0) || header.assistFlags < 0),
    version < FORMAT.newGamePlus && header.newGamePlusCount !== 0,
    version < FORMAT.mods && (header.isModded || header.mods.length > 0),
    version < FORMAT.modIds && header.modIdMaps.length > 0,
    version < FORMAT.savedDate && header.lastUpdated !== null,
  ]
  if (unsupportedValues.some(Boolean)) throw new CrystalSaveError('Header values cannot be represented in the original save format')
  if (version < FORMAT.modIds && header.mods.some(mod => mod.steamWorkshopFileId !== 0n) || version < FORMAT.animationIds && header.modIdMaps.some(map => (map.groups.animations?.length ?? 0) > 0)) throw new CrystalSaveError('Mod metadata cannot be represented in the original save format')
  writer.byte(header.invertedVersion ? 255 - version : version)
  if (version >= FORMAT.demo) writer.boolean(header.isDemo)
  if (version >= FORMAT.hardcore) writer.boolean(header.isHardcoreDefeat)
  for (const field of ['days', 'hours', 'minutes', 'seconds', 'milliseconds'] as const) writer.int32(header.playTime[field])
  if (version >= FORMAT.savedDate) for (const field of ['year', 'month', 'day', 'hour', 'minute', 'second'] as const) writer.int32(header.lastUpdated![field])
  writer.string(header.homePointName)
  writer.int32(header.currencyAmount)
  writer.int32(header.members.length)
  for (const member of header.members) {
    writer.boolean(member.isPresent)
    writer.string(member.name)
    writer.int32(member.level)
    writer.int32(member.genderId)
    writer.int32(member.jobId)
  }
  if (version >= FORMAT.difficulty) writer.int32(header.difficultyId)
  if (version >= FORMAT.patchMode) writer.byte(header.patchMode)
  if (version >= FORMAT.flags) {
    writer.int32(header.assistFlags)
    writer.int32(header.challengeFlags)
    writer.int32(header.randomizerFlags)
  } else if (version >= FORMAT.difficulty) for (let bit = 0; bit < 7; bit++) writer.boolean(Boolean(header.assistFlags & (1 << bit)))
  if (version >= FORMAT.newGamePlus) writer.int32(header.newGamePlusCount)
  if (header.mods.length > CRYSTAL_SAVE_LIMITS.maxMods || header.modIdMaps.length > CRYSTAL_SAVE_LIMITS.maxMods) throw new CrystalSaveError('Save exceeds the mod count limit')
  if (version >= FORMAT.mods) {
    writer.boolean(header.isModded)
    writer.int32(header.mods.length)
    for (const mod of header.mods) { writer.string(mod.id); writer.string(mod.title); writer.string(mod.version); if (version >= FORMAT.modIds) writer.int64(mod.steamWorkshopFileId, true) }
  }
  if (version < FORMAT.modIds) return
  writer.int32(header.modIdMaps.length)
  let totalMappings = 0
  for (const map of header.modIdMaps) {
    writer.string(map.modId)
    if (Object.keys(map.groups).some(group => !MOD_GROUPS.includes(group as typeof MOD_GROUPS[number]))) throw new CrystalSaveError('Unknown mod ID mapping group')
    for (const group of MOD_GROUPS) {
      if (group === 'animations' && version < FORMAT.animationIds) continue
      const pairs = map.groups[group] ?? []
      totalMappings += pairs.length
      if (totalMappings > CRYSTAL_SAVE_LIMITS.maxModMappings) throw new CrystalSaveError('Save exceeds the mod mapping count limit')
      writer.int32(pairs.length)
      for (const pair of pairs) { writer.int32(pair.originalId); writer.int32(pair.newId) }
    }
  }
}

function readMaps(reader: Reader): CrystalSaveMap[] {
  const ids = new Set<number>()
  return Array.from({ length: reader.count(CRYSTAL_SAVE_LIMITS.maxMaps, 'map', 24) }, () => {
    const id = reader.int32()
    if (id < 0 || ids.has(id)) reader.fail('Invalid or duplicate map ID')
    ids.add(id)
    const originX = reader.int32()
    const originY = reader.int32()
    const lengthX = reader.int32()
    const lengthY = reader.int32()
    const length = reader.int32()
    if (lengthX < 0 || lengthY < 0 || !Number.isSafeInteger(lengthX * lengthY) || length !== Math.ceil(lengthX * lengthY / 8)) reader.fail('Invalid map dimensions or bitmap length')
    return { id, originX, originY, lengthX, lengthY, data: reader.take(length) }
  })
}

function readCombatBytes(reader: Reader): Uint8Array {
  const start = reader.position
  reader.count(MAX_INT32, 'combat log')
  reader.take(reader.count(102400, 'combat buffer byte'))
  reader.take(reader.count(512000, 'combat archive byte'))
  if (reader.position !== reader.bytes.length) reader.fail('Unexpected trailing save data')
  return reader.bytes.slice(start)
}

export function decodeCrystalSave(bytes: Uint8Array): CrystalSave {
  if (bytes.length > CRYSTAL_SAVE_LIMITS.maxFileBytes) throw new CrystalSaveError('Save exceeds the 64 MiB file size limit')
  if (!bytes.length) throw new CrystalSaveError('Save file is truncated')
  const version = crystalSaveVersion(bytes[0])
  if (!isSupportedCrystalSaveVersion(version)) throw new CrystalSaveError(`Unsupported save format ${version}; the native reader supports formats ${CRYSTAL_SAVE_MIN_VERSION} to ${CRYSTAL_SAVE_VERSION}`)
  const decoded = new Uint8Array(bytes)
  for (let index = prefixBytes(version); index < decoded.length; index++) decoded[index] ^= 0xff
  const reader = new Reader(decoded)
  const header = readHeader(reader)
  const party = reader.document() as BsonDocument
  const members = Array.from({ length: MEMBER_COUNT }, () => reader.document() as BsonDocument)
  const maps = readMaps(reader)
  const combatBytes = readCombatBytes(reader)
  return { originalBytes: new Uint8Array(bytes), header, party, members, maps, combatBytes }
}

export function encodeCrystalSave(save: CrystalSave): Uint8Array {
  if (save.members.length !== MEMBER_COUNT || save.party.type !== 'document' || save.members.some(member => member.type !== 'document')) throw new CrystalSaveError('Save requires a party document and four member documents')
  const writer = new Writer()
  writeHeader(writer, save.header)
  writer.document(save.party)
  for (const member of save.members) writer.document(member)
  if (save.maps.length > CRYSTAL_SAVE_LIMITS.maxMaps) throw new CrystalSaveError('Save exceeds the map count limit')
  writer.int32(save.maps.length)
  for (const map of save.maps) {
    writer.int32(map.id)
    writer.int32(map.originX)
    writer.int32(map.originY)
    writer.int32(map.lengthX)
    writer.int32(map.lengthY)
    writer.int32(map.data.length)
    writer.append(map.data)
  }
  // Combat state is opaque to this editor; reconstructing it from known fields would discard unsupported state
  writer.append(save.combatBytes)
  const bytes = writer.finish()
  for (let index = prefixBytes(save.header.version); index < bytes.length; index++) bytes[index] ^= 0xff
  decodeCrystalSave(bytes)
  return bytes
}
