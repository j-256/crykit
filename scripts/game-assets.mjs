import { createHash } from 'node:crypto'

export const GAME_ASSET_FILE_PATTERN = /^[a-f0-9]{64}\.png$/
export const GAME_ARTWORK_RIGHTS = 'Copyrighted Crystal Project game artwork; no separate license grant asserted'
export const GAME_ASSET_MANIFEST_SCHEMA = 1
export const GAME_IDENTITY_MANIFEST_SCHEMA = 1
export const REVIEWED_NATIVE_IDENTITY_SOURCE = 'reviewed-native-item'
export const MAX_GAME_ASSET_BYTES = 20 * 1024 * 1024
export const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

const TEXTURE_HEADER_BYTES = 7
const MAX_TEXTURE_COUNT = 100_000
const MAX_TEXTURE_NAME_BYTES = 4_096
const MAX_TEXTURE_BYTES = 256 * 1024 * 1024
const ICON_COLUMNS = 7
const ICON_STRIDE = 34
const ICON_INSET = 2
const ICON_SIZE = 32
const ACTOR_BASE_WIDTH = 75
const ACTOR_BASE_HEIGHT = 144
const ACTOR_ICON_X = 30
const ACTOR_ICON_Y = 7
const ACTOR_ICON_WIDTH = 15
const ACTOR_ICON_HEIGHT = 15
const CLASS_ICON_GAP = 2

export const hash = bytes => createHash('sha256').update(bytes).digest('hex')

export function reviewedNativeMappings(manifest, existingMappings = {}) {
  if (manifest?.schemaVersion !== GAME_IDENTITY_MANIFEST_SCHEMA || manifest.database !== 'item' || !/^[a-f0-9]{64}$/.test(manifest.databaseSha256 ?? '') || !Array.isArray(manifest.records) || !manifest.records.length) throw new Error('Reviewed native identity manifest is invalid')
  const mappings = {}
  const nativeIds = new Set()
  for (const record of manifest.records) {
    if (typeof record.id !== 'string' || !/^base:item:[a-z0-9-]+$/.test(record.id) || record.kind !== 'item' || typeof record.name !== 'string' || !record.name.trim() || !Number.isInteger(record.databaseId) || record.databaseId < 0) throw new Error('Reviewed native identity record is invalid')
    if (existingMappings[record.id] || mappings[record.id] || nativeIds.has(record.databaseId)) throw new Error(`Reviewed native identity is duplicated: ${record.id}`)
    nativeIds.add(record.databaseId)
    mappings[record.id] = { kind: record.kind, name: record.name, sourceKey: REVIEWED_NATIVE_IDENTITY_SOURCE, database: manifest.database, databaseId: record.databaseId, databaseSha256: manifest.databaseSha256, locator: `Database/${manifest.database}.dat record ${record.databaseId}` }
  }
  return mappings
}

export function nativeArtworkIdentity(mapping) {
  if (mapping.sourceKey === REVIEWED_NATIVE_IDENTITY_SOURCE) return { sourceKey: mapping.sourceKey, databaseSha256: mapping.databaseSha256, locator: mapping.locator }
  return { sourceKey: mapping.sourceKey, upstreamName: mapping.upstreamName, upstreamCode: mapping.upstreamCode, url: mapping.sourceUrl, locator: mapping.locator }
}

export function verifyReviewedNativeDatabase(mapping, bytes, record) {
  if (mapping.sourceKey !== REVIEWED_NATIVE_IDENTITY_SOURCE) return
  // A same-name record at a reused ID cannot carry an old review across changed database bytes
  if (hash(bytes) !== mapping.databaseSha256) throw new Error(`Reviewed native identity needs review for changed database bytes: ${mapping.database}`)
  if (record?.ID !== mapping.databaseId || record.Name !== mapping.name) throw new Error(`Reviewed native identity does not match the installed record: ${mapping.name}`)
}

function requireBytes(bytes, offset, length, label) {
  if (!Buffer.isBuffer(bytes) || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > bytes.length) throw new Error(`${label} is truncated`)
}

function readUInt32(bytes, state, label) {
  requireBytes(bytes, state.offset, 4, label)
  const value = bytes.readUInt32LE(state.offset)
  state.offset += 4
  return value
}

function readBoundedBytes(bytes, state, length, maximum, label) {
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum) throw new Error(`${label} exceeds its supported size`)
  requireBytes(bytes, state.offset, length, label)
  const value = bytes.subarray(state.offset, state.offset + length)
  state.offset += length
  return value
}

export function pngInfo(bytes, label = 'PNG') {
  if (!Buffer.isBuffer(bytes) || bytes.length < 24 || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) || bytes.subarray(12, 16).toString('ascii') !== 'IHDR') throw new Error(`${label} is not a supported PNG`)
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  if (!width || !height) throw new Error(`${label} has invalid dimensions`)
  return { width, height }
}

export function parseTexturePack(bytes, packName = 'Texture') {
  requireBytes(bytes, 0, 6, `${packName} texture pack`)
  const version = bytes.readUInt16LE(0)
  const count = bytes.readUInt32LE(2)
  if (count > MAX_TEXTURE_COUNT) throw new Error(`${packName} texture count exceeds the supported limit`)
  const state = { offset: 6 }
  const headers = []
  for (let index = 0; index < count; index += 1) {
    headers.push(readBoundedBytes(bytes, state, TEXTURE_HEADER_BYTES, TEXTURE_HEADER_BYTES, `${packName} texture header`).toString('hex'))
  }
  const textures = []
  const names = new Set()
  for (let index = 0; index < count; index += 1) {
    const nameLength = readUInt32(bytes, state, `${packName} texture name length`)
    const nameBytes = readBoundedBytes(bytes, state, nameLength, MAX_TEXTURE_NAME_BYTES, `${packName} texture name`)
    const name = nameBytes.toString('utf8')
    if (!name || !Buffer.from(name, 'utf8').equals(nameBytes) || name.includes('\0')) throw new Error(`${packName} contains an invalid texture name`)
    if (names.has(name)) throw new Error(`${packName} contains a duplicate texture name: ${name}`)
    names.add(name)
    const imageLength = readUInt32(bytes, state, `${packName}/${name} byte length`)
    const image = readBoundedBytes(bytes, state, imageLength, MAX_TEXTURE_BYTES, `${packName}/${name}`)
    const dimensions = pngInfo(image, `${packName}/${name}`)
    textures.push({ index, name, path: `${packName}/${name}`, header: headers[index], bytes: image, sha256: hash(image), size: image.length, ...dimensions })
  }
  if (state.offset !== bytes.length) throw new Error(`${packName} texture pack has trailing bytes`)
  return { version, count, textures }
}

export function parseGameDatabase(bytes, name = 'database') {
  requireBytes(bytes, 0, 3, `${name} database`)
  const version = bytes.readUInt16LE(0)
  const encoded = bytes.subarray(2)
  const decoded = Buffer.allocUnsafe(encoded.length)
  for (let index = 0; index < encoded.length; index += 1) decoded[index] = 255 - encoded[index]
  let records
  try { records = JSON.parse(decoded.toString('utf8')) } catch (error) { throw new Error(`${name} database does not contain valid inverted JSON: ${error.message}`, { cause: error }) }
  return { version, records }
}

export function gameIconRegion(index, image) {
  if (!Number.isInteger(index) || index < 0) throw new Error('Game icon index must be a nonnegative integer')
  const region = {
    x: (index % ICON_COLUMNS) * ICON_STRIDE + ICON_INSET,
    y: Math.floor(index / ICON_COLUMNS) * ICON_STRIDE + ICON_INSET,
    width: ICON_SIZE,
    height: ICON_SIZE,
  }
  validateRegion(region, image, `Game icon ${index}`)
  return region
}

export function actorIconRegion(image) {
  if (!image || !Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1) throw new Error('Actor texture dimensions are invalid')
  const region = {
    x: Math.trunc(image.width * ACTOR_ICON_X / ACTOR_BASE_WIDTH),
    y: Math.trunc(image.height * ACTOR_ICON_Y / ACTOR_BASE_HEIGHT),
    width: Math.trunc(image.width * ACTOR_ICON_WIDTH / ACTOR_BASE_WIDTH),
    height: Math.trunc(image.height * ACTOR_ICON_HEIGHT / ACTOR_BASE_HEIGHT),
  }
  validateRegion(region, image, 'Actor icon')
  return region
}

export function classCompositeDimensions(regions) {
  if (!Array.isArray(regions) || regions.length < 1) throw new Error('Class artwork needs at least one actor region')
  return {
    width: regions.reduce((total, region) => total + region.width, 0) + CLASS_ICON_GAP * (regions.length - 1),
    height: Math.max(...regions.map(region => region.height)),
    gap: CLASS_ICON_GAP,
  }
}

export function validateRegion(region, image, label = 'Image region') {
  if (!region || !image || !['x', 'y', 'width', 'height'].every(key => Number.isInteger(region[key])) || region.x < 0 || region.y < 0 || region.width < 1 || region.height < 1 || region.x + region.width > image.width || region.y + region.height > image.height) throw new Error(`${label} falls outside its source texture`)
}

function escapePointer(value) {
  return String(value).replaceAll('~', '~0').replaceAll('/', '~1')
}

function textureCandidateKey(key) {
  return /(?:TexturePath|TextureKey|IconPath)/.test(key)
}

function adjacentTextureIndex(key, object) {
  const candidates = key === 'TexturePath' ? ['TextureIndex']
    : key === 'IconTexturePath' ? ['IconTextureIndex']
      : key.endsWith('TexturePath') ? [`${key.slice(0, -'Path'.length)}Index`, 'TextureIndex']
        : key === 'IconPath' ? ['IconIndex'] : []
  return candidates.map(candidate => object[candidate]).find(Number.isInteger)
}

export function databaseTextureReferences(databaseName, records, texturePaths) {
  if (!(texturePaths instanceof Set)) throw new Error('Texture paths must be supplied as a Set')
  const references = []
  const unresolved = []
  const walk = (value, pointer, context) => {
    if (!value || typeof value !== 'object') return
    const nextContext = !Array.isArray(value) && Number.isInteger(value.ID)
      ? { id: value.ID, ...(typeof value.Name === 'string' ? { name: value.Name } : {}) }
      : context
    for (const [key, nested] of Object.entries(value)) {
      const nestedPointer = `${pointer}/${escapePointer(key)}`
      if (typeof nested === 'string') {
        if (texturePaths.has(nested)) {
          const index = adjacentTextureIndex(key, value)
          references.push({ database: databaseName, pointer: nestedPointer, texturePath: nested, ...(index === undefined ? {} : { textureIndex: index }), ...(nextContext ? { record: nextContext } : {}) })
        } else if (textureCandidateKey(key) && nested) {
          unresolved.push({ database: databaseName, pointer: nestedPointer, value: nested, ...(nextContext ? { record: nextContext } : {}) })
        }
      } else walk(nested, nestedPointer, nextContext)
    }
  }
  walk(records, '', undefined)
  return { references, unresolved }
}

export function safeTextureRelativePath(packName, textureName) {
  const parts = [packName, ...textureName.split('/')]
  if (parts.some(part => !part || part === '.' || part === '..' || part.includes('\\') || part.includes('\0'))) throw new Error('Texture name cannot be written as a safe relative path')
  return `${parts.join('/')}.png`
}

export function parseStarterRecords(source) {
  const records = [...source.matchAll(/^  (\["[^\n]+\]),$/gm)].map(match => JSON.parse(match[1]))
  if (!records.length || records.some(record => !Array.isArray(record) || record.length !== 4 || record.some(value => typeof value !== 'string'))) throw new Error('The starter identity records could not be read')
  return records.map(([id, kind, name, sourceKey]) => ({ id, kind, name, sourceKey }))
}

export function parsePythonStringAssignments(source, sourceFile = 'constants.py') {
  const assignments = new Map()
  for (const match of source.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("(?:\\.|[^"\\])*")\s*(?:#.*)?$/gm)) {
    const value = JSON.parse(match[2])
    if (assignments.has(match[1]) && assignments.get(match[1]) !== value) throw new Error(`${sourceFile} redefines ${match[1]}`)
    assignments.set(match[1], value)
  }
  return assignments
}

export function parseArchipelagoItems(source, constants) {
  const offsets = new Map([...source.matchAll(/^([a-z_]+_index_offset)\s*=\s*(\d+)\s*$/gm)].map(match => [match[1], Number(match[2])]))
  const lineStarts = [0]
  for (let index = 0; index < source.length; index += 1) if (source[index] === '\n') lineStarts.push(index + 1)
  const lineFor = offset => {
    let low = 0
    let high = lineStarts.length
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2)
      if (lineStarts[middle] <= offset) low = middle
      else high = middle
    }
    return low + 1
  }
  const pattern = /^[ \t]*(?:("(?:\\.|[^"\\])*")|([A-Za-z_][A-Za-z0-9_]*))[ \t]*:[ \t]*ItemData\([ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*,[ \t]*(\d+)[ \t]*\+[ \t]*([a-z_]+_index_offset)\b/gm
  const items = []
  for (const match of source.matchAll(pattern)) {
    const offset = offsets.get(match[5])
    if (offset === undefined) throw new Error(`Unknown Archipelago offset ${match[5]}`)
    const name = match[1] ? JSON.parse(match[1]) : constants.get(match[2])
    if (!name) throw new Error(`Unresolved Archipelago item constant ${match[2]}`)
    const database = match[5] === 'job_index_offset' ? 'job'
      : match[5] === 'item_index_offset' ? 'item'
        : match[5] === 'equipment_index_offset' ? 'equipment'
          : match[5] === 'scholar_index_offset' ? 'ability' : undefined
    items.push({ name, category: match[3], database, databaseId: Number(match[4]), code: Number(match[4]) + offset, offset: match[5], line: lineFor(match.index) })
  }
  if (!items.length) throw new Error('No Archipelago ItemData entries were found')
  return items
}

function expectedArchipelagoNames(record) {
  if (record.sourceKey === 'apworld-classes' && record.kind === 'class') return [`Job - ${record.name}`]
  if (record.sourceKey === 'apworld-monster-magic' && record.kind === 'monsterMagic') return [`Scholar - ${record.name}`]
  if (record.sourceKey === 'apworld-items' && record.kind === 'item') return [`Item - ${record.name}`, `Equipment - ${record.name}`]
  return []
}

export function buildGameIdentityCrosswalk(starterRecords, archipelagoItems) {
  const byName = new Map()
  for (const item of archipelagoItems) byName.set(item.name, [...(byName.get(item.name) ?? []), item])
  const mappings = {}
  const unresolved = []
  for (const record of starterRecords) {
    const expectedNames = expectedArchipelagoNames(record)
    if (!expectedNames.length) {
      unresolved.push({ id: record.id, kind: record.kind, name: record.name, sourceKey: record.sourceKey, reason: 'Catalog identity source has no reviewed native database crosswalk' })
      continue
    }
    const candidates = expectedNames.flatMap(name => byName.get(name) ?? []).filter(item => item.database)
    if (candidates.length !== 1) {
      unresolved.push({ id: record.id, kind: record.kind, name: record.name, sourceKey: record.sourceKey, expectedUpstreamNames: expectedNames, reason: candidates.length ? 'Multiple reviewed upstream records match this identity' : 'No reviewed upstream record maps this identity to a native database ID' })
      continue
    }
    const candidate = candidates[0]
    mappings[record.id] = {
      kind: record.kind,
      name: record.name,
      sourceKey: record.sourceKey,
      upstreamName: candidate.name,
      upstreamCategory: candidate.category,
      upstreamCode: candidate.code,
      database: candidate.database,
      databaseId: candidate.databaseId,
      locator: `worlds/crystal_project/items.py:${candidate.line}`,
    }
  }
  return { mappings, unresolved }
}

export function stableSourceDigest(files) {
  const digest = createHash('sha256')
  for (const [name, content] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
    digest.update(name)
    digest.update('\0')
    digest.update(content)
    digest.update('\0')
  }
  return digest.digest('hex')
}
