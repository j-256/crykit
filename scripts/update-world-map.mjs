#!/usr/bin/env node
import { readFile, writeFile, mkdir, rename, stat, readdir } from 'node:fs/promises'
import { dirname, join, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { contentDigest, extractEntityReference } from './update-entity-reference.mjs'
import { GAME_ARTWORK_RIGHTS, hash, parseGameDatabase, parseTexturePack, pngInfo } from './game-assets.mjs'
import { encodeMapSurface, decodeMapSurface, MAP_SURFACE_LIMITS } from '../src/domain/map-surface.ts'
import { encodeMapGeometry, decodeMapGeometry, MAP_GEOMETRY } from '../src/domain/map-geometry.ts'
import { readVoxelChunks, exposedVoxelTiles } from './lib/map-geometry.mjs'
import { MAP_LAYERS, MAP_CELL_SIZE, MAP_HEIGHT_SHADES, readMapArchive, readTerrainMaps, composeTerrain, renderTerrain, mapRegions, projectMapMarkers } from './lib/world-map.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OUTPUT = join(ROOT, 'src/catalog/world-map.json')
const ASSETS = join(ROOT, 'src/assets/world-map')
const MAX_BYTES = 32 * 1024 * 1024
const HASH_PATTERN = /^[a-f0-9]{64}$/
const SCOPE = 'Fully revealed native field maps and normalized placement facts'
const LAST_VANILLA_ENTITY_ID = 3824
export const WORLD_MAP_SOURCE_PINS = Object.freeze({
  voxel: { path: 'Content/Database/voxel.dat', sha256: '2767a8d1298dff7d44d9c440e7b8ff69e549c17a7fd0e01424b7da52123c137b', size: 190325 },
  textures: { path: 'Content/Textures/Voxel.dat', sha256: '425990b2dd1732045afda604e422c8e3880d242b14ed8c99ec378b881a0b27c5', size: 689562 },
  atlas: { path: 'Voxel/VoxelAtlas', sha256: 'e1dcd938426bf3e52682c2ad9f2ef0dc37471991fe0272f203fa7d4b24d0cdcb', width: 432, height: 432 },
})
const USAGE = `Usage: node --experimental-strip-types scripts/update-world-map.mjs -i|--input <installation-or-Content>
       node --experimental-strip-types scripts/update-world-map.mjs --check
Generate native map layers and normalized markers from an owned Windows game.
  -i, --input <path>  Installation containing Crystal Project.exe, or its Content
      --check         Validate committed maps, asset hashes and source pins offline
  -h, --help          Show help
Update requires Node >=22.12, the lockfile-installed sharp package, and .NET SDK 10.
Check requires Node only. No network requests or environment variables are needed.
Installed game, editor, world, databases and atlas must match reviewed fingerprints.
The installed entity decoder runs only after its executable fingerprint matches.
The generator saves terrain PNGs and placement facts without dialogue or scripts.
No installation files change. All layers are revealed without using a player save.
Output: src/catalog/world-map.json and src/assets/world-map/ PNG, surface and geometry tiles
Results go to stdout; diagnostics go to stderr.
Exit: 0 success/help, 1 integrity/read failure, 2 invalid options, 3 missing dependency.
`

async function boundedRead(path) {
  const info = await stat(path)
  if (!info.isFile() || info.size <= 0 || info.size > MAX_BYTES) throw new Error('Map source is not a bounded regular file')
  const bytes = await readFile(path)
  if (bytes.length !== info.size) throw new Error('Map source changed while reading')
  return bytes
}

async function writeIfChanged(path, bytes) {
  const previous = await readFile(path).catch(error => { if (error.code !== 'ENOENT') throw error; return null })
  if (previous?.equals(Buffer.from(bytes))) return
  await writeFile(`${path}.tmp`, bytes)
  await rename(`${path}.tmp`, path)
}

export function validateWorldMap(snapshot, native, reference, schema) {
  const require = (condition, message) => { if (!condition) throw new Error(message) }
  const source = snapshot?.source
  require(snapshot?.schemaVersion === 1 && source?.scope === SCOPE && source.platform === 'Windows' && source.rights === GAME_ARTWORK_RIGHTS, 'Invalid world map schema or source scope')
  require(source.gameVersion === native.source.gameVersion && source.gameVersion === reference.source.gameVersion && source.nativeContentDigest === native.contentDigest && source.referenceSchemaDigest === schema.contentDigest, 'World map version or metadata pin differs')
  require(source.gameExecutableSha256 === native.source.executable.sha256 && source.editorExecutableSha256 === reference.source.editorExecutableSha256, 'World map executable pin differs')
  require(source.lastVanillaEntityId === LAST_VANILLA_ENTITY_ID, 'World map vanilla entity namespace pin differs')
  for (const key of ['world', 'biomes']) require(JSON.stringify(source[key]) === JSON.stringify(reference.source[key]), `World map ${key} source pin differs`)
  for (const key of ['voxel', 'textures', 'atlas']) require(JSON.stringify(source[key]) === JSON.stringify(WORLD_MAP_SOURCE_PINS[key]), `World map ${key} source pin differs`)
  require(source.systemSha256 === native.source.files.find(file => file.path === 'Database/system.dat')?.sha256, 'World map system source pin differs')
  require(JSON.stringify(source.enums) === JSON.stringify({ ActionType: schema.enums.ModelEntityNpcActionType, ConditionType: schema.enums.ModelEntityConditionType }), 'World map enumeration source differs')
  require(source.evidence?.length > 0 && source.evidence.every(value => typeof value === 'string' && value && !value.startsWith('/') && !value.includes('\\')), 'World map evidence must be portable')
  const bounds = snapshot.bounds
  require(bounds && Object.keys(bounds).sort().join(',') === 'height,width,x,z' && Object.values(bounds).every(Number.isSafeInteger) && bounds.width > 0 && bounds.height > 0 && bounds.width * bounds.height <= 2_000_000, 'Invalid world map bounds')
  require(snapshot.layers?.length === MAP_LAYERS.length, 'Incomplete world map layers')
  require(source.rendering?.cellSize === MAP_CELL_SIZE && JSON.stringify(source.rendering.heightShades) === JSON.stringify(MAP_HEIGHT_SHADES) && source.rendering.fullyRevealed === true && source.rendering.playerSaveUsed === false, 'World map rendering contract differs')
  for (let index = 0; index < MAP_LAYERS.length; index += 1) {
    const layer = snapshot.layers[index]
    require(layer.id === MAP_LAYERS[index].id && layer.label === native.databases.system.Vocab.General[`MapLayer_${MAP_LAYERS[index].key}`] && layer.image === `layer-${layer.id}.png`, 'World map layer identity differs')
    require(layer.surface?.file === `surface-${layer.id}.json` && HASH_PATTERN.test(layer.surface.sha256) && Number.isSafeInteger(layer.surface.size) && layer.surface.size > 0 && layer.surface.size <= MAX_BYTES, 'Invalid world map surface metadata')
    require(Array.isArray(layer.geometry) && layer.geometry.length <= MAP_GEOMETRY.tiles, 'Invalid world map geometry tiles')
    const tileFiles = new Set()
    for (const tile of layer.geometry) {
      const b = tile.bounds
      require(b && Object.keys(b).sort().join(',') === 'height,width,x,z' && Object.values(b).every(Number.isSafeInteger) && b.x >= bounds.x && b.z >= bounds.z && b.width > 0 && b.height > 0 && b.width <= MAP_GEOMETRY.tileSide && b.height <= MAP_GEOMETRY.tileSide && b.x + b.width <= bounds.x + bounds.width && b.z + b.height <= bounds.z + bounds.height, 'Invalid geometry tile bounds')
      const column = (b.x - bounds.x) / MAP_GEOMETRY.tileSide
      const row = (b.z - bounds.z) / MAP_GEOMETRY.tileSide
      require(Number.isInteger(column) && Number.isInteger(row) && tile.file === `geometry-${layer.id}-${column}-${row}.bin` && !tileFiles.has(tile.file) && HASH_PATTERN.test(tile.sha256) && Number.isSafeInteger(tile.size) && tile.size > 0 && tile.size <= MAP_GEOMETRY.bytes && Number.isInteger(tile.minY) && Number.isInteger(tile.maxY) && tile.minY >= 0 && tile.maxY <= MAP_GEOMETRY.height && tile.minY < tile.maxY, 'Invalid geometry tile metadata')
      tileFiles.add(tile.file)
    }
    require(layer.width === bounds.width * MAP_CELL_SIZE && layer.height === bounds.height * MAP_CELL_SIZE && HASH_PATTERN.test(layer.sha256) && Number.isSafeInteger(layer.size) && layer.size > 0 && layer.size <= MAX_BYTES, 'Invalid world map layer asset metadata')
  }
  require(source.rendering.surfaceHeight === 'World Y above mapped voxel', 'Invalid map surface rendering contract')
  for (const field of ['voxelColors', 'voxelSideColors']) require(source[field] && Object.entries(source[field]).every(([id, color]) => Number.isInteger(Number(id)) && Number(id) >= 0 && Number(id) < MAP_SURFACE_LIMITS.empty && /^#[a-f0-9]{6}$/.test(color)), 'Invalid native voxel color preview')
  require(Array.isArray(snapshot.regions) && Array.isArray(snapshot.markers) && snapshot.markers.length <= 100_000 && Array.isArray(source.mapHeaders) && source.mapHeaders.length <= 256, 'Invalid world map collections')
  const biomes = new Map(native.databases.biome.filter(Boolean).map(record => [record.ID, record]))
  const regions = new Map()
  for (const region of snapshot.regions) {
    require(!regions.has(region.id) && biomes.get(region.id)?.Name === region.name && MAP_LAYERS.some(layer => layer.id === region.layer) && Number.isSafeInteger(region.x) && Number.isSafeInteger(region.z), 'Invalid or duplicate world map region')
    regions.set(region.id, region)
  }
  const entities = new Map(reference.records.map(record => [record.ID, record]))
  const ids = new Set()
  const kinds = ['chest', 'npc', 'shop', 'boss', 'encounter', 'crystal', 'home', 'entrance', 'sign', 'resource', 'object']
  const families = ['item', 'equipment', 'recipe', 'job', 'troop', 'monster', 'spark']
  const allowed = new Set(['id', 'entityId', 'kind', 'sourceId', 'sourceName', 'change', 'name', 'region', 'biomeId', 'layer', 'x', 'y', 'z', 'description', 'targets', 'conditions', 'warnings'])
  for (const marker of snapshot.markers) {
    const entity = entities.get(marker.entityId)
    require(Object.keys(marker).every(key => allowed.has(key)) && entity && !ids.has(marker.id) && marker.id === `base:entity:${entity.ID}` && marker.sourceId === 'base' && marker.sourceName === 'Base game' && marker.change === 'base' && kinds.includes(marker.kind), 'Invalid world map marker identity')
    require(marker.biomeId === entity.BiomeID && marker.x === entity.Coord.X && marker.y === entity.Coord.Y && marker.z === entity.Coord.Z && marker.region === (entity.BiomeID === 0 ? null : entity.BiomeName), 'World map marker location differs')
    require(marker.layer === null || marker.layer === regions.get(marker.biomeId)?.layer, 'World map marker layer differs')
    require(typeof marker.name === 'string' && marker.name.length > 0 && typeof marker.description === 'string' && Array.isArray(marker.targets), 'Invalid world map marker label or targets')
    for (const target of marker.targets) require(families.includes(target.family) && native.databases[target.family].some(record => record?.ID === target.id) && target.sourceId === 'base' && typeof target.name === 'string' && target.name.length > 0, 'Unresolved world map target identity')
    for (const key of ['conditions', 'warnings']) require(marker[key] === undefined || Array.isArray(marker[key]) && marker[key].every(value => typeof value === 'string' && value.length > 0), 'Invalid world map condition or warning')
    ids.add(marker.id)
  }
  for (const entity of reference.records) if (entity.EntityType === 'Treasure') require(ids.has(`base:entity:${entity.ID}`), 'World map chest coverage is incomplete')
  require(HASH_PATTERN.test(snapshot.contentDigest) && snapshot.contentDigest === contentDigest(snapshot), 'World map content digest differs')
}

async function pins() {
  return Promise.all(['src/catalog/native-game-data.json', 'src/mod-inspector/entity-reference.json', 'src/mod-inspector/reference-schema.json'].map(path => readFile(join(ROOT, path), 'utf8').then(JSON.parse)))
}

function nativeVoxelColors(voxels, atlas, side = false) {
  return Object.fromEntries(voxels.filter(voxel => voxel && !voxel.IsInvalid && voxel.ID < MAP_SURFACE_LIMITS.empty).map(voxel => {
    // Growth voxels use their declared base material for the averaged side preview
    // Actual supporting materials, variants and special meshes remain outside this color approximation
    const base = voxel.GrowsOn ? voxels[voxel.GrowsOn] : voxel
    const samples = side ? voxels.map(value => value?.ID === voxel.ID ? { ...value, TexTopU: base.TexSideU, TexTopV: base.TexSideV } : value) : voxels
    const pixels = renderTerrain(Buffer.from([voxel.ID, 1, 0]), { x: 0, z: 0, width: 1, height: 1 }, samples, atlas).data
    const rgb = [0, 1, 2].map(channel => {
      let sum = 0
      for (let offset = channel; offset < pixels.length; offset += 4) sum += pixels[offset]
      return Math.round(sum / (pixels.length / 4)).toString(16).padStart(2, '0')
    })
    return [voxel.ID, `#${rgb.join('')}`]
  }))
}

async function update(input, native, reference, schema) {
  let sharp
  try { sharp = (await import('sharp')).default } catch { const error = new Error('Map update requires the lockfile-installed sharp package'); error.exitCode = 3; throw error }
  const installation = basename(resolve(input)).toLowerCase() === 'content' ? dirname(resolve(input)) : resolve(input)
  const sourcePaths = ['Content/Worlds/field.dat', 'Content/Database/voxel.dat', 'Content/Textures/Voxel.dat', 'Content/Database/system.dat']
  const [world, voxel, textures, systemBytes] = await Promise.all(sourcePaths.map(path => boundedRead(join(installation, path))))
  const expected = [reference.source.world, WORLD_MAP_SOURCE_PINS.voxel, WORLD_MAP_SOURCE_PINS.textures, native.source.files.find(file => file.path === 'Database/system.dat')]
  for (let index = 0; index < expected.length; index += 1) if (hash([world, voxel, textures, systemBytes][index]) !== expected[index]?.sha256 || [world, voxel, textures, systemBytes][index].length !== expected[index]?.size) throw new Error(`Map source fingerprint differs: ${sourcePaths[index]}`)
  const atlasTexture = parseTexturePack(textures, 'Voxel').textures.find(texture => texture.path === WORLD_MAP_SOURCE_PINS.atlas.path)
  if (atlasTexture?.sha256 !== WORLD_MAP_SOURCE_PINS.atlas.sha256 || atlasTexture.width !== WORLD_MAP_SOURCE_PINS.atlas.width || atlasTexture.height !== WORLD_MAP_SOURCE_PINS.atlas.height) throw new Error('Map atlas fingerprint or dimensions differ')
  const { source, records } = await extractEntityReference(input, true)
  const entries = readMapArchive(world)
  const maps = readTerrainMaps(entries)
  const worldMap = maps.find(map => map.id === -1)
  const bounds = { x: worldMap.x, z: worldMap.z, width: worldMap.width, height: worldMap.height }
  const biomes = new Map(native.databases.biome.filter(Boolean).map(record => [record.ID, record]))
  const regions = mapRegions(maps, biomes)
  const system = parseGameDatabase(systemBytes, 'system').records
  const voxels = parseGameDatabase(voxel, 'voxel').records
  const markers = projectMapMarkers(records, native.databases, regions, system, voxels)
  const decoded = await sharp(atlasTexture.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const atlas = { ...decoded.info, data: decoded.data }
  await mkdir(ASSETS, { recursive: true })
  // Average native top-face map samples without inventing textures or collision geometry
  const voxelColors = nativeVoxelColors(voxels, atlas)
  const voxelSideColors = nativeVoxelColors(voxels, atlas, true)
  console.error('Extracting exposed native voxel faces')
  const geometryTiles = exposedVoxelTiles(readVoxelChunks(entries.get('field.dat')), biomes, voxels, bounds)
  const geometryByLayer = new Map(MAP_LAYERS.map(layer => [layer.id, []]))
  for (const tile of geometryTiles) {
    const bytes = encodeMapGeometry(tile.cells, tile.bounds, tile.layer)
    const metadata = { file: `geometry-${tile.layer}-${tile.column}-${tile.row}.bin`, size: bytes.length, sha256: hash(bytes), bounds: tile.bounds, minY: tile.minY, maxY: tile.maxY }
    decodeMapGeometry(bytes, metadata, tile.layer)
    await writeIfChanged(join(ASSETS, metadata.file), bytes)
    geometryByLayer.get(tile.layer).push(metadata)
  }
  const layers = []
  for (const layer of MAP_LAYERS) {
    console.error(`Rendering ${system.Vocab.General[`MapLayer_${layer.key}`]} native terrain`)
    const cells = composeTerrain(maps, biomes, bounds, layer.id)
    const surfaceBytes = Buffer.from(encodeMapSurface(cells, bounds, layer.id))
    const surface = { file: `surface-${layer.id}.json`, sha256: hash(surfaceBytes), size: surfaceBytes.length }
    await writeIfChanged(join(ASSETS, surface.file), surfaceBytes)
    const pixels = renderTerrain(cells, bounds, voxels, atlas)
    const png = await sharp(pixels.data, { raw: { width: pixels.width, height: pixels.height, channels: 4 } }).png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer()
    const image = `layer-${layer.id}.png`
    await writeIfChanged(join(ASSETS, image), png)
    layers.push({ id: layer.id, label: system.Vocab.General[`MapLayer_${layer.key}`], image, surface, geometry: geometryByLayer.get(layer.id), width: pixels.width, height: pixels.height, sha256: hash(png), size: png.length })
  }
  const snapshot = { schemaVersion: 1, contentDigest: '', source: { ...source, scope: SCOPE, rights: GAME_ARTWORK_RIGHTS, nativeContentDigest: native.contentDigest, referenceSchemaDigest: schema.contentDigest, systemSha256: hash(systemBytes), lastVanillaEntityId: LAST_VANILLA_ENTITY_ID, ...WORLD_MAP_SOURCE_PINS, voxelColors, voxelSideColors, voxelNames: Object.fromEntries(voxels.filter(Boolean).map(voxel => [voxel.ID, voxel.Name])), enums: { ActionType: schema.enums.ModelEntityNpcActionType, ConditionType: schema.enums.ModelEntityConditionType }, rendering: { surfaceHeight: 'World Y above mapped voxel', surfaceGeometry: 'Selected map surface heights; separate geometry tiles retain exposed native voxel runs by assigned biome layer', voxelColors: 'Average native top and side samples; special voxel meshes use block previews', cellSize: MAP_CELL_SIZE, heightShades: MAP_HEIGHT_SHADES, underwaterOpacity: 0.65, fullyRevealed: true, playerSaveUsed: false, atlasSampling: 'Native point sampling with height shading and underwater overlay', edgeNeighbors: 'Wrap at complete world-map bounds' }, mapHeaders: maps.filter(map => map.id !== -1).map(({ cells: _cells, ...header }) => header), evidence: [...source.evidence, 'Sang.Voxel.ZLookup.LoadBinary and VoxelChunk.IO_ReadStreamVoxelData', 'Sang.Voxel.PrimitiveBuilder.SolidPrimitiveBuilder exposed face rules', 'Sang.Map.VoxelMapData.LoadHeaderStream/LoadRegionStream', 'Sang.Map.VoxelMapCollection.ProcessChunk/ProcessChunkVoxel records world Y above the mapped voxel', 'Sang.Map.VoxelMapCollection.GetNearbyMaps', 'Sang.Map.VoxelMapViewer.WriteLocalMapData/DrawMapCoords', 'Sang.Voxel.CVoxel.InitializeVoxelTypes', 'Sang.Map.CMap.Initialize/InitializeVocab', 'Sang.Field.Entity.EntityNpc.RefreshCurrentOutfit/InterpretSpecialOutfit/InterpretSpecialVoxel', 'Sang.Common.StringInterpreter.AppendCharacterVariable/AppendItemVariable/AppendMonsterVariable', 'Sang.Field.Entity.EntityTreasure.Interact and Sang.PartyData.Currency.Collect', 'Sang.Window.WindowHelper.DrawCurrency copper/silver/gold denominations', 'Sang.PartyData.HMods.RefreshOrigIDCache/IsNewEntity/PopulateEntities', 'Sang.SangData.ModCompiler.RedirectEntity', 'Sang.SangEntity.SangEntityNpcActionType.Battle and Troop.Members/Monster.IsBoss', 'Sang.SangEntity.SangEntityNpcActionType.PlaySEMineOre/Garden/AddInventory and authored outfit TextureKey/VoxelID'] }, bounds, layers, regions, markers }
  snapshot.contentDigest = contentDigest(snapshot)
  validateWorldMap(snapshot, native, reference, schema)
  const output = `${JSON.stringify(snapshot, null, 2).replace(/[\u2014\u2018\u2019\u201c\u201d]/g, char => `\\u${char.charCodeAt(0).toString(16)}`)}\n`
  await writeIfChanged(OUTPUT, output)
  console.log('Saved fingerprinted native world maps and placement facts')
}

async function main() {
  let values
  try {
    const parsed = parseArgs({ options: { input: { type: 'string', short: 'i' }, check: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } }, strict: true, allowPositionals: true })
    values = parsed.values
    if (values.help) { process.stdout.write(USAGE); return }
    if (parsed.positionals.length) throw new Error('Unexpected positional arguments')
    if (values.check && values.input !== undefined) throw new Error('--check cannot be combined with --input')
    if (!values.check && !values.input?.trim()) throw new Error('--input is required when updating maps')
  } catch (error) { console.error(error.message); process.exitCode = 2; return }
  try {
    const [native, reference, schema] = await pins()
    if (!values.check) return await update(values.input, native, reference, schema)
    const snapshot = JSON.parse(await readFile(OUTPUT, 'utf8'))
    validateWorldMap(snapshot, native, reference, schema)
    for (const layer of snapshot.layers) {
      for (const tile of layer.geometry) {
        const bytes = await boundedRead(join(ASSETS, tile.file))
        if (bytes.length !== tile.size || hash(bytes) !== tile.sha256) throw new Error(`World map geometry differs: ${tile.file}`)
        decodeMapGeometry(bytes, tile, layer.id)
      }
      const bytes = await boundedRead(join(ASSETS, layer.image))
      const surfaceBytes = await boundedRead(join(ASSETS, layer.surface.file))
      if (hash(surfaceBytes) !== layer.surface.sha256 || surfaceBytes.length !== layer.surface.size) throw new Error(`World map surface differs: ${layer.surface.file}`)
      decodeMapSurface(surfaceBytes.toString('utf8'), snapshot.bounds, layer.id)
      const dimensions = pngInfo(bytes)
      if (hash(bytes) !== layer.sha256 || bytes.length !== layer.size || dimensions.width !== layer.width || dimensions.height !== layer.height) throw new Error(`World map asset differs: ${layer.image}`)
    }
    const expectedGeometry = new Set(snapshot.layers.flatMap(layer => layer.geometry.map(tile => tile.file)))
    const actualGeometry = (await readdir(ASSETS)).filter(file => file.startsWith('geometry-'))
    if (actualGeometry.length !== expectedGeometry.size || actualGeometry.some(file => !expectedGeometry.has(file))) throw new Error('World map geometry asset membership differs')
    console.log('Verified native world maps, exact source pins, markers and PNG digests offline')
  } catch (error) { console.error(error.message); process.exitCode = error.exitCode ?? 1 }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
