import { Reader, Writer } from './binary.ts'
import { type CrystalSaveMap, type CrystalSave, type BsonDocument } from './types.ts'
import { CRYSTAL_SAVE_LIMITS, MAX_INT32, crystalSaveVersion, isSupportedCrystalSaveVersion, CRYSTAL_SAVE_MIN_VERSION, CRYSTAL_SAVE_VERSION, prefixBytes, MEMBER_COUNT } from './format.ts'
import { CrystalSaveError } from './error.ts'
import { readHeader, writeHeader } from './header.ts'

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
  // Decoding never mutates caller-owned bytes; the encrypted source remains available for recovery
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
  // Combat state is opaque to this editor; reconstructing it would discard unsupported state
  writer.append(save.combatBytes)
  const bytes = writer.finish()
  for (let index = prefixBytes(save.header.version); index < bytes.length; index++) bytes[index] ^= 0xff
  // Re-read the finished framing so inconsistent map, opaque, or combat sections cannot escape
  decodeCrystalSave(bytes)
  return bytes
}
