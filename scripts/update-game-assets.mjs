#!/usr/bin/env node
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import sharp from 'sharp'
import { CURRENCY_ARTWORK_EXTRACTION, NATIVE_UI_ARTWORK, NO_NATIVE_ARTWORK, nativeArtworkEntries, nativeArtworkPlan, validateNativeArtworkCoverage, validateNativeUiArtwork } from './native-artwork.mjs'
import { validateContentBounds, visibleContentBounds } from './sprite-content-bounds.mjs'
import { GAME_ARTWORK_RIGHTS, GAME_ASSET_FILE_PATTERN, GAME_ASSET_MANIFEST_SCHEMA, GAME_IDENTITY_MANIFEST_SCHEMA, MAX_GAME_ASSET_BYTES, REVIEWED_NATIVE_IDENTITY_SOURCE, actorIconRegion, classCompositeDimensions, databaseTextureReferences, gameIconRegion, hash, nativeArtworkIdentity, parseGameDatabase, parseStarterRecords, parseTexturePack, pngInfo, reviewedNativeMappings, safeTextureRelativePath, stableSourceDigest, validateRegion, verifyReviewedNativeDatabase } from './game-assets.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ASSETS = join(ROOT, 'src', 'assets', 'game-assets')
const MANIFEST = join(ROOT, 'src', 'catalog', 'game-assets.json')
const ARTWORK_MANIFEST = join(ROOT, 'src', 'catalog', 'game-artwork.json')
const IDENTITIES = join(ROOT, 'src', 'catalog', 'game-identities.json')
const REVIEWED_IDENTITIES = join(ROOT, 'src', 'catalog', 'game-travel-identities.json')
const NATIVE_DEFINITIONS = join(ROOT, 'src', 'catalog', 'native-game-data.json')
const STARTER_SOURCE = join(ROOT, 'src', 'catalog', 'data.ts')
const CACHE = join(ROOT, '.game-cache')
const EXECUTABLE_NAME = 'Crystal Project.exe'
const TEXTURE_DIRECTORY = 'Textures'
const DATABASE_DIRECTORY = 'Database'
const OPAQUE_DATABASE_FILES = new Set(['loading.dat'])
const FORMAT_SOURCE_COMMIT = '79320b343d603aa069aa023fd54020d36419e082'
const FORMAT_SOURCES = Object.freeze({
  texturePack: `https://github.com/iconmaster5326/CrystalProjector/blob/${FORMAT_SOURCE_COMMIT}/schema/ksy/texture_pack.ksy`,
  database: `https://github.com/iconmaster5326/CrystalProjector/blob/${FORMAT_SOURCE_COMMIT}/schema/ksy/database.ksy`,
})
const QUINTAR_GUIDE_ARTWORK = Object.freeze({
  babel: { label: 'Babel Quintar', texturePath: 'Icon/ItemA', itemId: 167, itemName: 'Babel Quintar', textureIndex: 39 },
  ocarina: { label: 'Quintar Ocarina', texturePath: 'Icon/ItemA', itemId: 115, itemName: 'Quintar Ocarina', textureIndex: 35 },
  egg: { label: 'Quintar egg', texturePath: 'Monster/Z15_QuintarEgg', monsterId: 51, monsterName: 'Quintar Egg' },
  trustyBlue: { label: 'Trusty Blue', texturePath: 'Monster/Z15_QuintarTrustyBlue', monsterId: 317, monsterName: 'Trusty Quintar', typeKey: 'QUINTAR_Type_Blue', typeName: 'Blue' },
  trustyRed: { label: 'Trusty Red', texturePath: 'Monster/Z15_QuintarTrustyRed', monsterId: 304, monsterName: 'Trusty Quintar', typeKey: 'QUINTAR_Type_Red', typeName: 'Red' },
  wokeRiver: { label: 'Woke River', texturePath: 'Monster/Z52_QuintarWokeTeal', monsterId: 318, monsterName: 'Woke Quintar', typeKey: 'QUINTAR_Type_Teal', typeName: 'River' },
  brutishDesert: { label: 'Brutish Desert', texturePath: 'Monster/Z18_QuintarBrutishYellow', monsterId: 316, monsterName: 'Brutish Quintar', typeKey: 'QUINTAR_Type_Yellow', typeName: 'Desert' },
  golden: { label: 'Golden Quintar', texturePath: 'Actor/Animal_QuintarGolden', typeKey: 'QUINTAR_Type_Gold', typeName: 'Golden', region: { x: 3, y: 75, width: 40, height: 23 } },
})
const USAGE = `Usage: node --experimental-strip-types scripts/update-game-assets.mjs -i|--input <Content> [-u|--unpack <directory>] [-h|--help]
       node --experimental-strip-types scripts/update-game-assets.mjs --check [-h|--help]
Inventory an installed Crystal Project Windows Content directory and extract exact
catalog, UI, and Quintar guide artwork from native database IDs and texture regions,
using the fingerprinted native gameplay snapshot and hash-pinned reviewed identities.
The committed manifest contains hashes and provenance, never the machine-local path.
Requires Node >=22.12 with TypeScript stripping and committed native gameplay data.
  -i, --input <Content>     Installed game's Content directory
  -u, --unpack <directory> Write every named embedded texture to a new directory
      --check               Validate committed assets and manifests without game files
  -h, --help                Show this help
The optional unpack target must not exist and must be outside the repository.
Results go to stdout; progress and errors go to stderr.
Exit: 0 success/help, 1 runtime or integrity failure, 2 invalid options.
`

function options() {
  try {
    const { values } = parseArgs({ options: { help: { type: 'boolean', short: 'h' }, input: { type: 'string', short: 'i' }, unpack: { type: 'string', short: 'u' }, check: { type: 'boolean' } }, strict: true })
    if (values.help) { process.stdout.write(USAGE); process.exit(0) }
    if (values.check && (values.input || values.unpack)) throw new Error('--check cannot be combined with --input or --unpack')
    if (!values.check && !values.input) throw new Error('--input is required when extracting game assets')
    if (values.unpack) {
      const target = resolve(values.unpack)
      const fromRoot = relative(ROOT, target)
      if (!fromRoot || (!fromRoot.startsWith('..') && !fromRoot.includes(':'))) throw new Error('--unpack must point outside the repository')
      values.unpack = target
    }
    return values
  } catch (error) { console.error(error.message); process.exit(2) }
}

function sortedJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function inputDigest(entries) {
  return stableSourceDigest(entries.map(entry => [entry.path, entry.sha256]))
}

async function readInstalledGame(contentDirectory) {
  const input = resolve(contentDirectory)
  const textureNames = (await readdir(join(input, TEXTURE_DIRECTORY), { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith('.dat')).map(entry => entry.name).sort()
  const databaseNames = (await readdir(join(input, DATABASE_DIRECTORY), { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith('.dat')).map(entry => entry.name).sort()
  if (!textureNames.length || !databaseNames.length) throw new Error('Input does not contain Crystal Project texture packs and databases')
  const texturePacks = new Map()
  const textureFiles = []
  for (const file of textureNames) {
    const bytes = await readFile(join(input, TEXTURE_DIRECTORY, file))
    const name = basename(file, '.dat')
    const parsed = parseTexturePack(bytes, name)
    texturePacks.set(name, parsed)
    textureFiles.push({ path: `${TEXTURE_DIRECTORY}/${file}`, sha256: hash(bytes), size: bytes.length })
  }
  const databases = new Map()
  const databaseFiles = []
  for (const file of databaseNames) {
    const bytes = await readFile(join(input, DATABASE_DIRECTORY, file))
    const name = basename(file, '.dat')
    databases.set(name, OPAQUE_DATABASE_FILES.has(file) ? { format: 'opaque', records: null, bytes } : { format: 'inverted-json', ...parseGameDatabase(bytes, name), bytes })
    databaseFiles.push({ path: `${DATABASE_DIRECTORY}/${file}`, sha256: hash(bytes), size: bytes.length })
  }
  const executable = await readFile(join(input, '..', EXECUTABLE_NAME))
  const executableFile = { path: EXECUTABLE_NAME, sha256: hash(executable), size: executable.length }
  const files = [...textureFiles, ...databaseFiles, executableFile]
  return { texturePacks, databases, files, inputDigest: inputDigest(files) }
}

function textureInventory(texturePacks) {
  const paths = new Map()
  const packs = {}
  for (const [packName, pack] of texturePacks) {
    packs[packName] = {
      version: pack.version,
      count: pack.count,
      textures: pack.textures.map(({ bytes: _bytes, ...texture }) => texture),
    }
    for (const texture of pack.textures) {
      if (paths.has(texture.path)) throw new Error(`Duplicate texture path across packs: ${texture.path}`)
      paths.set(texture.path, texture)
    }
  }
  return { packs, paths }
}

function databaseInventory(databases) {
  return Object.fromEntries([...databases].map(([name, database]) => [name, {
    format: database.format,
    ...(database.version === undefined ? {} : { version: database.version }),
    records: database.records === null ? null : Array.isArray(database.records) ? database.records.filter(Boolean).length : Object.keys(database.records ?? {}).length,
    ...(Array.isArray(database.records) ? { slots: database.records.length } : {}),
  }]))
}

function recordIndex(database, name) {
  if (!database || !Array.isArray(database.records)) throw new Error(`${name} database is not a record array`)
  const records = new Map()
  for (const record of database.records) {
    if (record === null) continue
    if (!record || !Number.isInteger(record.ID) || records.has(record.ID)) throw new Error(`${name} database has an invalid or duplicate record ID`)
    records.set(record.ID, record)
  }
  return records
}

function artworkGap(mapping, reason, details = {}) {
  return { id: mapping.id, kind: mapping.kind, name: mapping.name, database: mapping.database, databaseId: mapping.databaseId, reason, ...details }
}

async function renderIcon(texture, index) {
  const region = gameIconRegion(index, texture)
  const bytes = await sharp(texture.bytes).extract({ left: region.x, top: region.y, width: region.width, height: region.height }).png({ compressionLevel: 9 }).toBuffer()
  return { bytes, sources: [{ texturePath: texture.path, textureSha256: texture.sha256, region }], extraction: '32x32 indexed game icon cell' }
}

async function renderClass(record, textures) {
  const variants = [
    ['ActorTexturePathM', record.ActorTexturePathM],
    ['ActorTexturePathF', record.ActorTexturePathF],
  ]
  if (variants.some(([, path]) => typeof path !== 'string' || !path)) throw new Error('Class record does not provide both actor texture variants')
  const prepared = variants.map(([field, path]) => {
    const texture = textures.get(path)
    if (!texture) throw new Error(`Class actor texture is missing: ${path}`)
    const region = actorIconRegion(texture)
    return { field, texture, region }
  })
  const dimensions = classCompositeDimensions(prepared.map(entry => entry.region))
  const crops = await Promise.all(prepared.map(entry => sharp(entry.texture.bytes).extract({ left: entry.region.x, top: entry.region.y, width: entry.region.width, height: entry.region.height }).png({ compressionLevel: 9 }).toBuffer()))
  let left = 0
  const layers = crops.map((input, index) => {
    const layer = { input, left, top: 0 }
    left += prepared[index].region.width + dimensions.gap
    return layer
  })
  const bytes = await sharp({ create: { width: dimensions.width, height: dimensions.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(layers).png({ compressionLevel: 9 }).toBuffer()
  return {
    bytes,
    sources: prepared.map(entry => ({ field: entry.field, texturePath: entry.texture.path, textureSha256: entry.texture.sha256, region: entry.region })),
    extraction: 'paired actor-sheet class icons',
  }
}

async function addArtwork(assets, outputs, rendered) {
  const sha256 = hash(rendered.bytes)
  const file = `${sha256}.png`
  const dimensions = pngInfo(rendered.bytes, 'Extracted artwork')
  const contentBounds = await visibleContentBounds(rendered.bytes)
  const sourceKey = source => JSON.stringify(source)
  const existing = assets[sha256]
  if (existing) {
    const sources = new Map(existing.sourceTextures.map(source => [sourceKey(source), source]))
    for (const source of rendered.sources) sources.set(sourceKey(source), source)
    existing.sourceTextures = [...sources.values()]
    existing.extractions = [...new Set([...existing.extractions, rendered.extraction])]
  } else {
    assets[sha256] = { file, sha256, size: rendered.bytes.length, ...dimensions, contentBounds, rights: GAME_ARTWORK_RIGHTS, extractions: [rendered.extraction], sourceTextures: rendered.sources }
  }
  outputs.set(file, rendered.bytes)
  return sha256
}

async function buildBindings(identityManifest, databases, textures) {
  const assets = {}
  const outputs = new Map()
  const entities = {}
  const unmapped = []
  const nameDifferences = []
  const requiredDatabases = new Set(Object.values(identityManifest.mappings).map(mapping => mapping.database))
  const indexes = new Map([...databases].filter(([name]) => requiredDatabases.has(name)).map(([name, database]) => [name, recordIndex(database, name)]))
  for (const [id, sourceMapping] of Object.entries(identityManifest.mappings)) {
    const mapping = { id, ...sourceMapping }
    const record = indexes.get(mapping.database)?.get(mapping.databaseId)
    verifyReviewedNativeDatabase(mapping, databases.get(mapping.database)?.bytes, record)
    if (!record) {
      unmapped.push(artworkGap(mapping, 'Pinned native database ID is absent from the installed game files'))
      continue
    }
    if (record.Name !== mapping.name) nameDifferences.push({ id, kind: mapping.kind, catalogName: mapping.name, installedName: typeof record.Name === 'string' ? record.Name : null, database: mapping.database, databaseId: mapping.databaseId })
    let rendered
    try {
      if (mapping.kind === 'class' && mapping.database === 'job') rendered = await renderClass(record, textures)
      else if ((mapping.kind === 'item' && ['item', 'equipment'].includes(mapping.database)) || (mapping.kind === 'monsterMagic' && mapping.database === 'ability')) {
        if (typeof record.TexturePath !== 'string' || !record.TexturePath || !Number.isInteger(record.TextureIndex)) throw new Error('Native database record has no direct indexed texture')
        const texture = textures.get(record.TexturePath)
        if (!texture) throw new Error(`Referenced texture is absent: ${record.TexturePath}`)
        rendered = await renderIcon(texture, record.TextureIndex)
      } else throw new Error('Native database type is not a reviewed artwork mapping')
    } catch (error) {
      unmapped.push(artworkGap(mapping, error.message))
      continue
    }
    const asset = await addArtwork(assets, outputs, rendered)
    entities[id] = {
      kind: mapping.kind,
      name: mapping.name,
      asset,
      database: { name: mapping.database, id: mapping.databaseId, recordName: record.Name },
      identity: nativeArtworkIdentity(mapping),
      rendering: { extraction: rendered.extraction, sourceTextures: rendered.sources },
    }
  }
  return { assets, outputs, entities, unmapped, nameDifferences }
}

async function buildNativeDefinitionArtwork(snapshot, textures, built) {
  const gaps = []
  for (const entry of nativeArtworkEntries(snapshot)) {
    const plan = nativeArtworkPlan(entry, textures)
    if (!plan) {
      gaps.push({ id: entry.id, kind: entry.kind, name: entry.name, nativeRecord: entry.nativeRecord, reason: NO_NATIVE_ARTWORK })
      continue
    }
    let rendered
    if (plan.type === 'class') rendered = await renderClass(entry.record, textures)
    else {
      const source = plan.sourceTextures[0]
      const texture = textures.get(source.texturePath)
      const region = source.region
      const bytes = plan.type === 'monster' ? texture.bytes : await sharp(texture.bytes).extract({ left: region.x, top: region.y, width: region.width, height: region.height }).png({ compressionLevel: 9 }).toBuffer()
      rendered = { bytes, sources: plan.sourceTextures, extraction: plan.extraction }
    }
    const asset = await addArtwork(built.assets, built.outputs, rendered)
    const previous = built.entities[entry.id]
    if (previous && (previous.asset !== asset || previous.kind !== entry.kind)) throw new Error(`Native definition disagrees with reviewed artwork: ${entry.id}`)
    built.entities[entry.id] = {
      ...previous,
      kind: entry.kind, name: previous?.name ?? entry.name, asset,
      database: { name: entry.nativeRecord.database, id: entry.record.ID, recordName: entry.record.Name },
      nativeRecord: entry.nativeRecord,
      rendering: { extraction: rendered.extraction, sourceTextures: rendered.sources },
    }
  }
  return gaps
}

function verifyNativeInputs(snapshot, files) {
  const installed = new Map(files.map(file => [file.path, file]))
  for (const expected of [snapshot.source.executable, ...snapshot.source.files]) {
    const actual = installed.get(expected.path)
    if (actual?.sha256 !== expected.sha256 || actual.size !== expected.size) throw new Error(`Native artwork input differs from the gameplay snapshot: ${expected.path}`)
  }
}

async function buildQuintarGuideArtwork(databases, textures, assets, outputs) {
  const monsterRecords = recordIndex(databases.get('monster'), 'monster')
  const itemRecords = recordIndex(databases.get('item'), 'item')
  const typeLabels = databases.get('system')?.records?.Vocab?.General
  if (!typeLabels) throw new Error('Quintar guide type labels are absent from the system database')
  const guide = {}
  for (const [key, source] of Object.entries(QUINTAR_GUIDE_ARTWORK)) {
    const texture = textures.get(source.texturePath)
    if (!texture) throw new Error(`Quintar guide texture is absent: ${source.texturePath}`)
    const record = source.monsterId !== undefined ? monsterRecords.get(source.monsterId) : source.itemId !== undefined ? itemRecords.get(source.itemId) : undefined
    if (source.monsterId !== undefined && (record?.Name !== source.monsterName || record.TexturePath !== source.texturePath)) throw new Error(`Quintar guide monster source changed: ${key}`)
    if (source.itemId !== undefined && (record?.Name !== source.itemName || record.TexturePath !== source.texturePath || record.TextureIndex !== source.textureIndex)) throw new Error(`Quintar guide item source changed: ${key}`)
    if (source.typeKey && typeLabels[source.typeKey] !== source.typeName) throw new Error(`Quintar guide type label changed: ${key}`)
    const region = source.itemId !== undefined ? gameIconRegion(record.TextureIndex, texture) : source.region ?? { x: 0, y: 0, width: texture.width, height: texture.height }
    validateRegion(region, texture, `Quintar guide ${key}`)
    const bytes = source.itemId !== undefined || source.region ? await sharp(texture.bytes).extract({ left: region.x, top: region.y, width: region.width, height: region.height }).png({ compressionLevel: 9 }).toBuffer() : texture.bytes
    const rendered = { bytes, sources: [{ texturePath: texture.path, textureSha256: texture.sha256, region }], extraction: source.itemId !== undefined ? '32x32 indexed game item icon cell' : source.region ? 'named golden actor-sheet frame' : 'named monster texture' }
    const asset = await addArtwork(assets, outputs, rendered)
    guide[key] = { label: source.label, asset, ...(record ? { database: { name: source.itemId !== undefined ? 'item' : 'monster', id: source.itemId ?? source.monsterId, recordName: record.Name } } : {}), ...(source.typeKey ? { gameType: { key: source.typeKey, name: source.typeName } } : {}), rendering: { extraction: rendered.extraction, sourceTextures: rendered.sources } }
  }
  return guide
}

async function buildUiArtwork(textures, built) {
  const artwork = {}
  for (const [key, source] of Object.entries(NATIVE_UI_ARTWORK)) {
    if (source.entityId) {
      const entity = built.entities[source.entityId]
      if (!entity) throw new Error(`Native UI artwork entity is absent: ${source.entityId}`)
      artwork[key] = { label: source.label, asset: entity.asset, entityId: source.entityId }
      continue
    }
    const texture = textures.get(source.texturePath)
    if (!texture) throw new Error(`Native UI artwork texture is absent: ${source.texturePath}`)
    const region = source.region
    validateRegion(region, texture, `Native UI artwork ${key}`)
    const bytes = await sharp(texture.bytes).extract({ left: region.x, top: region.y, width: region.width, height: region.height }).png({ compressionLevel: 9 }).toBuffer()
    const rendered = { bytes, sources: [{ texturePath: texture.path, textureSha256: texture.sha256, region }], extraction: CURRENCY_ARTWORK_EXTRACTION }
    const asset = await addArtwork(built.assets, built.outputs, rendered)
    artwork[key] = { label: source.label, asset, rendering: { extraction: rendered.extraction, sourceTextures: rendered.sources } }
  }
  return artwork
}

function visualReferenceInventory(databases, texturePaths) {
  const references = []
  const unresolved = []
  for (const [name, database] of databases) {
    if (database.records === null) continue
    const found = databaseTextureReferences(name, database.records, texturePaths)
    references.push(...found.references)
    unresolved.push(...found.unresolved)
  }
  const order = (left, right) => left.database.localeCompare(right.database) || left.pointer.localeCompare(right.pointer)
  return { references: references.sort(order), unresolved: unresolved.sort(order) }
}

async function unpackTextures(target, texturePacks, inventory, gameInputDigest) {
  await mkdir(target)
  for (const [packName, pack] of texturePacks) for (const texture of pack.textures) {
    const output = join(target, safeTextureRelativePath(packName, texture.name))
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, texture.bytes)
  }
  await writeFile(join(target, 'inventory.json'), sortedJson({ schemaVersion: 1, gameInputDigest, texturePacks: inventory }))
}

function checkIdentityManifest(manifest, starterRecords) {
  if (manifest.schemaVersion !== GAME_IDENTITY_MANIFEST_SCHEMA || !/^[a-f0-9]{40}$/.test(manifest.source?.commit ?? '') || !/^[a-f0-9]{64}$/.test(manifest.source?.contentDigest ?? '')) throw new Error('Game identity manifest is invalid or stale')
  const records = new Map(starterRecords.map(record => [record.id, record]))
  const covered = new Set()
  for (const [id, mapping] of Object.entries(manifest.mappings ?? {})) {
    const record = records.get(id)
    if (!record || record.kind !== mapping.kind || record.name !== mapping.name || record.sourceKey !== mapping.sourceKey) throw new Error(`Game identity mapping disagrees with the starter catalog: ${id}`)
    covered.add(id)
  }
  for (const gap of manifest.unresolved ?? []) {
    if (!records.has(gap.id) || covered.has(gap.id) || !gap.reason) throw new Error(`Invalid game identity coverage gap: ${gap.id}`)
    covered.add(gap.id)
  }
  if (covered.size !== starterRecords.length) throw new Error('Game identity manifest does not cover the starter catalog')
}

function runtimeArtworkManifest(manifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    gameInputDigest: manifest.gameInputDigest,
    sources: {
      rights: manifest.sources.rights,
      format: manifest.sources.format,
      executable: manifest.sources.executable,
      identityCrosswalk: manifest.sources.identityCrosswalk,
      reviewedIdentities: manifest.sources.reviewedIdentities,
      nativeDefinitions: manifest.sources.nativeDefinitions,
    },
    assets: Object.fromEntries(Object.entries(manifest.assets).map(([key, asset]) => {
      const { sourceTextures: _sourceTextures, extractions: _extractions, ...runtimeAsset } = asset
      return [key, runtimeAsset]
    })),
    entities: manifest.entities,
    quintarGuide: manifest.quintarGuide,
    uiArtwork: manifest.uiArtwork,
  }
}

async function checkManifest() {
  const starterRecords = parseStarterRecords(await readFile(STARTER_SOURCE, 'utf8'))
  const identityBytes = await readFile(IDENTITIES)
  const identityManifest = JSON.parse(identityBytes)
  checkIdentityManifest(identityManifest, starterRecords)
  const reviewedBytes = await readFile(REVIEWED_IDENTITIES)
  const reviewedMappings = reviewedNativeMappings(JSON.parse(reviewedBytes), identityManifest.mappings)
  const mappings = { ...identityManifest.mappings, ...reviewedMappings }
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'))
  const artworkManifest = JSON.parse(await readFile(ARTWORK_MANIFEST, 'utf8'))
  const nativeBytes = await readFile(NATIVE_DEFINITIONS)
  const snapshot = JSON.parse(nativeBytes)
  const nativeSource = { file: basename(NATIVE_DEFINITIONS), sha256: hash(nativeBytes), contentDigest: snapshot.contentDigest, platform: snapshot.source.platform, gameVersion: snapshot.source.gameVersion }
  if (JSON.stringify(manifest.sources.nativeDefinitions) !== JSON.stringify(nativeSource)) throw new Error('Native gameplay artwork input is stale')
  verifyNativeInputs(snapshot, [manifest.sources.executable, ...Object.values(manifest.sources.databases).map(database => database.file)])
  if (manifest.schemaVersion !== GAME_ASSET_MANIFEST_SCHEMA || manifest.sources?.identityCrosswalk?.sha256 !== hash(identityBytes) || manifest.sources?.identityCrosswalk?.commit !== identityManifest.source.commit || !/^[a-f0-9]{64}$/.test(manifest.gameInputDigest ?? '')) throw new Error('Game asset manifest schema or identity input is stale')
  if (manifest.sources.reviewedIdentities?.file !== basename(REVIEWED_IDENTITIES) || manifest.sources.reviewedIdentities.sha256 !== hash(reviewedBytes)) throw new Error('Reviewed native identity input is stale')
  for (const mapping of Object.values(reviewedMappings)) if (manifest.sources.databases[mapping.database]?.file.sha256 !== mapping.databaseSha256) throw new Error(`Reviewed native identity database pin is stale: ${mapping.database}`)
  if (JSON.stringify(artworkManifest) !== JSON.stringify(runtimeArtworkManifest(manifest))) throw new Error('Runtime game artwork manifest is stale')
  const textureByPath = new Map()
  for (const [packName, pack] of Object.entries(manifest.sources.texturePacks ?? {})) {
    if (pack.file?.path !== `${TEXTURE_DIRECTORY}/${packName}.dat` || !/^[a-f0-9]{64}$/.test(pack.file?.sha256 ?? '') || !Number.isInteger(pack.version) || pack.count !== pack.textures?.length) throw new Error(`Texture pack inventory is invalid: ${packName}`)
    for (const texture of pack.textures) {
      if (texture.path !== `${packName}/${texture.name}` || textureByPath.has(texture.path) || !/^[a-f0-9]{64}$/.test(texture.sha256 ?? '') || !Number.isInteger(texture.size) || texture.size < 1 || !Number.isInteger(texture.width) || !Number.isInteger(texture.height) || texture.width < 1 || texture.height < 1) throw new Error(`Texture inventory entry is invalid: ${texture.path}`)
      textureByPath.set(texture.path, texture)
    }
  }
  if (textureByPath.size !== manifest.sources.textureCount) throw new Error('Texture inventory count does not match the manifest')
  const validateTextureSource = source => {
    const texture = textureByPath.get(source.texturePath)
    if (!texture || source.textureSha256 !== texture.sha256) throw new Error(`Artwork source texture is not inventoried: ${source.texturePath}`)
    validateRegion(source.region, texture, `Artwork source ${source.texturePath}`)
  }
  const checkedFiles = new Set()
  let total = 0
  for (const [key, asset] of Object.entries(manifest.assets ?? {})) {
    if (key !== asset.sha256 || !GAME_ASSET_FILE_PATTERN.test(asset.file) || asset.file !== `${asset.sha256}.png` || asset.rights !== GAME_ARTWORK_RIGHTS || !asset.sourceTextures?.length || !asset.extractions?.length) throw new Error(`Invalid native artwork asset: ${key}`)
    asset.sourceTextures.forEach(validateTextureSource)
    const bytes = await readFile(join(ASSETS, asset.file))
    const dimensions = pngInfo(bytes, asset.file)
    if (hash(bytes) !== asset.sha256 || bytes.length !== asset.size || dimensions.width !== asset.width || dimensions.height !== asset.height) throw new Error(`Native artwork bytes do not match the manifest: ${asset.file}`)
    validateContentBounds(asset.contentBounds, asset)
    const actualBounds = await visibleContentBounds(bytes)
    if (JSON.stringify(actualBounds) !== JSON.stringify(asset.contentBounds)) throw new Error(`Native artwork content bounds mismatch: ${asset.file}`)
    if (!checkedFiles.has(asset.file)) total += bytes.length
    checkedFiles.add(asset.file)
  }
  if (total > MAX_GAME_ASSET_BYTES) throw new Error('Native artwork snapshot exceeds the total size limit')
  const catalogById = new Map([...starterRecords, ...Object.entries(reviewedMappings).map(([id, mapping]) => ({ id, ...mapping }))].map(record => [record.id, record]))
  const coveredMappings = new Set()
  for (const [id, binding] of Object.entries(manifest.entities ?? {})) {
    const record = catalogById.get(id)
    const mapping = mappings[id]
    if (mapping && (!record || record.kind !== binding.kind || record.name !== binding.name || !manifest.assets[binding.asset] || !binding.rendering?.sourceTextures?.length || JSON.stringify(binding.identity) !== JSON.stringify(nativeArtworkIdentity(mapping)) || binding.database?.name !== mapping.database || binding.database.id !== mapping.databaseId)) throw new Error(`Native artwork binding is invalid: ${id}`)
    if (mapping?.sourceKey === REVIEWED_NATIVE_IDENTITY_SOURCE && binding.database.recordName !== mapping.name) throw new Error(`Reviewed native identity label is invalid: ${id}`)
    if (!manifest.assets[binding.asset] || !binding.rendering?.sourceTextures?.length || (!mapping && (!binding.nativeRecord || binding.identity))) throw new Error(`Native artwork binding is invalid: ${id}`)
    binding.rendering.sourceTextures.forEach(validateTextureSource)
    const assetSources = new Set(manifest.assets[binding.asset].sourceTextures.map(source => JSON.stringify(source)))
    if (binding.rendering.sourceTextures.some(source => !assetSources.has(JSON.stringify(source)))) throw new Error(`Native artwork binding sources disagree with its asset: ${id}`)
    if (mapping) coveredMappings.add(id)
  }
  validateNativeArtworkCoverage(manifest, nativeArtworkEntries(snapshot), textureByPath)
  validateNativeUiArtwork(manifest, textureByPath)
  for (const gap of manifest.coverage?.unmappedNativeIdentities ?? []) {
    if (!mappings[gap.id] || coveredMappings.has(gap.id) || !gap.reason) throw new Error(`Native artwork gap is invalid: ${gap.id}`)
    coveredMappings.add(gap.id)
  }
  if (coveredMappings.size !== Object.keys(mappings).length) throw new Error('Native artwork manifest does not cover every mapped native identity')
  if (JSON.stringify(Object.keys(manifest.quintarGuide ?? {})) !== JSON.stringify(Object.keys(QUINTAR_GUIDE_ARTWORK))) throw new Error('Quintar guide artwork coverage is invalid')
  for (const [key, source] of Object.entries(QUINTAR_GUIDE_ARTWORK)) {
    const binding = manifest.quintarGuide[key]
    const asset = binding && manifest.assets[binding.asset]
    const texture = textureByPath.get(source.texturePath)
    const region = source.itemId !== undefined && texture ? gameIconRegion(source.textureIndex, texture) : source.region ?? { x: 0, y: 0, width: texture?.width, height: texture?.height }
    const extraction = source.itemId !== undefined ? '32x32 indexed game item icon cell' : source.region ? 'named golden actor-sheet frame' : 'named monster texture'
    if (!binding || !asset || !texture || binding.label !== source.label || binding.rendering?.extraction !== extraction || JSON.stringify(binding.rendering.sourceTextures) !== JSON.stringify([{ texturePath: source.texturePath, textureSha256: texture.sha256, region }])) throw new Error(`Quintar guide artwork binding is invalid: ${key}`)
    if (!asset.sourceTextures.some(entry => JSON.stringify(entry) === JSON.stringify(binding.rendering.sourceTextures[0]))) throw new Error(`Quintar guide artwork source disagrees with its asset: ${key}`)
    const expectedDatabase = source.itemId !== undefined ? { name: 'item', id: source.itemId, recordName: source.itemName } : source.monsterId !== undefined ? { name: 'monster', id: source.monsterId, recordName: source.monsterName } : undefined
    if (JSON.stringify(binding.database) !== JSON.stringify(expectedDatabase)) throw new Error(`Quintar guide database binding is invalid: ${key}`)
    if (source.typeKey === undefined ? binding.gameType !== undefined : binding.gameType?.key !== source.typeKey || binding.gameType.name !== source.typeName) throw new Error(`Quintar guide type binding is invalid: ${key}`)
  }
  const differences = new Set()
  for (const difference of manifest.coverage?.identityNameDifferences ?? []) {
    const binding = manifest.entities[difference.id]
    if (!binding || differences.has(difference.id) || difference.catalogName === difference.installedName || binding.name !== difference.catalogName || binding.database.recordName !== difference.installedName || binding.database.name !== difference.database || binding.database.id !== difference.databaseId) throw new Error(`Native identity name difference is invalid: ${difference.id}`)
    differences.add(difference.id)
  }
  for (const reference of manifest.coverage?.databaseVisualReferences ?? []) if (!textureByPath.has(reference.texturePath) || typeof reference.pointer !== 'string') throw new Error(`Database texture reference is invalid: ${reference.database}${reference.pointer}`)
  if (JSON.stringify(manifest.coverage.identityGaps) !== JSON.stringify(identityManifest.unresolved)) throw new Error('Native artwork identity gaps disagree with the crosswalk')
  const files = (await readdir(ASSETS)).sort()
  if (files.length !== checkedFiles.size || files.some(file => !checkedFiles.has(file))) throw new Error('Native artwork directory contains files absent from the manifest')
  console.log(`Verified ${checkedFiles.size} native artwork files (${total} bytes), ${Object.keys(manifest.entities).length} catalog bindings, ${manifest.sources.textureCount} embedded textures, and ${manifest.coverage.databaseVisualReferences.length} database texture references`)
}

async function update(flags) {
  const identityBytes = await readFile(IDENTITIES)
  const identityManifest = JSON.parse(identityBytes)
  const starterRecords = parseStarterRecords(await readFile(STARTER_SOURCE, 'utf8'))
  checkIdentityManifest(identityManifest, starterRecords)
  const reviewedBytes = await readFile(REVIEWED_IDENTITIES)
  const reviewedMappings = reviewedNativeMappings(JSON.parse(reviewedBytes), identityManifest.mappings)
  const nativeBytes = await readFile(NATIVE_DEFINITIONS)
  const snapshot = JSON.parse(nativeBytes)
  console.error('Reading and validating installed game databases and texture packs')
  const game = await readInstalledGame(flags.input)
  verifyNativeInputs(snapshot, game.files)
  const textureData = textureInventory(game.texturePacks)
  const visuals = visualReferenceInventory(game.databases, new Set(textureData.paths.keys()))
  console.error('Extracting catalog-bound native artwork from reviewed database IDs')
  const built = await buildBindings({ ...identityManifest, mappings: { ...identityManifest.mappings, ...reviewedMappings } }, game.databases, textureData.paths)
  console.error('Extracting native catalog artwork from exact base and mode records')
  const nativeDefinitionGaps = await buildNativeDefinitionArtwork(snapshot, textureData.paths, built)
  console.error('Extracting Quintar guide artwork from reviewed game sources')
  const quintarGuide = await buildQuintarGuideArtwork(game.databases, textureData.paths, built.assets, built.outputs)
  console.error('Extracting UI artwork from exact catalog bindings and game currency rectangles')
  const uiArtwork = await buildUiArtwork(textureData.paths, built)
  let total = 0
  for (const bytes of built.outputs.values()) total += bytes.length
  if (total > MAX_GAME_ASSET_BYTES) throw new Error('Native artwork snapshot exceeds the total size limit')
  const textureFiles = new Map(game.files.filter(file => file.path.startsWith(`${TEXTURE_DIRECTORY}/`)).map(file => [basename(file.path, '.dat'), file]))
  const databaseFiles = new Map(game.files.filter(file => file.path.startsWith(`${DATABASE_DIRECTORY}/`)).map(file => [basename(file.path, '.dat'), file]))
  const manifest = {
    schemaVersion: GAME_ASSET_MANIFEST_SCHEMA,
    gameInputDigest: game.inputDigest,
    sources: {
      rights: GAME_ARTWORK_RIGHTS,
      format: { commit: FORMAT_SOURCE_COMMIT, ...FORMAT_SOURCES },
      executable: game.files.find(file => file.path === EXECUTABLE_NAME),
      identityCrosswalk: { sha256: hash(identityBytes), commit: identityManifest.source.commit, repository: identityManifest.source.repository },
      reviewedIdentities: { file: basename(REVIEWED_IDENTITIES), sha256: hash(reviewedBytes) },
      nativeDefinitions: { file: basename(NATIVE_DEFINITIONS), sha256: hash(nativeBytes), contentDigest: snapshot.contentDigest, platform: snapshot.source.platform, gameVersion: snapshot.source.gameVersion },
      textureCount: textureData.paths.size,
      texturePacks: Object.fromEntries(Object.entries(textureData.packs).map(([name, pack]) => [name, { file: textureFiles.get(name), ...pack }])),
      databases: Object.fromEntries(Object.entries(databaseInventory(game.databases)).map(([name, database]) => [name, { file: databaseFiles.get(name), ...database }])),
    },
    assets: built.assets,
    entities: built.entities,
    quintarGuide,
    uiArtwork,
    coverage: {
      nativeDefinitionGaps,
      identityGaps: identityManifest.unresolved,
      unmappedNativeIdentities: built.unmapped,
      identityNameDifferences: built.nameDifferences,
      databaseVisualReferences: visuals.references,
      unresolvedTextureReferences: visuals.unresolved,
    },
  }
  await mkdir(ASSETS, { recursive: true })
  for (const [file, bytes] of built.outputs) await writeFile(join(ASSETS, file), bytes)
  await mkdir(CACHE, { recursive: true })
  const temporary = join(CACHE, 'game-assets.json')
  await writeFile(temporary, sortedJson(manifest))
  await rename(temporary, MANIFEST)
  const temporaryArtwork = join(CACHE, 'game-artwork.json')
  await writeFile(temporaryArtwork, sortedJson(runtimeArtworkManifest(manifest)))
  await rename(temporaryArtwork, ARTWORK_MANIFEST)
  if (flags.unpack) {
    console.error(`Writing all embedded textures to ${flags.unpack}`)
    await unpackTextures(flags.unpack, game.texturePacks, textureData.packs, game.inputDigest)
  }
  console.log(`Saved ${built.outputs.size} native artwork files (${total} bytes) for ${Object.keys(built.entities).length} catalog definitions; inventoried ${textureData.paths.size} embedded textures and ${visuals.references.length} database references; ${built.unmapped.length} mapped identities retain explicit artwork gaps`)
}

try {
  const flags = options()
  if (flags.check) await checkManifest()
  else await update(flags)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
