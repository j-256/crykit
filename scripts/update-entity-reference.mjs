#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { cp, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { parseGameDatabase } from './game-assets.mjs'
import { parseGameExecutableVersion } from './game-version.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OUTPUT = join(ROOT, 'src/mod-inspector/entity-reference.json')
const MAX_BYTES = 32 * 1024 * 1024
const TYPES = ['Npc', 'Sign', 'Spark', 'Door', 'HomePoint', 'Treasure', 'Crystal', 'Marker']
const NAME_SOURCES = ['EntityType', 'NpcData.Key', 'NpcData.Outfits[0].Name', 'HomePointData.Name', 'MarkerData.Key', 'SignData.Title']
const RIGHTS = 'Source-specific game/editor data; no content license asserted'
const SCOPE = 'Crystal Edit field world baseline'
const isInt32 = value => Number.isInteger(value) && value >= -2147483648 && value <= 2147483647
const DOTNET_ENV = { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', DOTNET_NOLOGO: '1' }
const HASH_PATTERN = /^[a-f0-9]{64}$/
const USAGE = `Usage: node scripts/update-entity-reference.mjs -i|--input <installation-or-Content>
       node scripts/update-entity-reference.mjs --check
Generate the field-world entity metadata index from an owned Windows installation.
  -i, --input <path>  Installation root containing Crystal Project.exe, or Content
      --check         Validate committed records, digest, and source pins offline
  -h, --help          Show help
Update requires Node >=22.12 and .NET SDK 10. No NuGet packages or network requests
are needed. The installed game decoder is executed only after its fingerprint
matches the reviewed schema and native snapshot. A temporary assembly copy adapts
its PE architecture header to the host; installed files are never changed.
Only metadata is saved; no world binaries, dialogue, scripts, or machine paths.
Check requires Node only. No environment variables are required.
Results go to stdout; diagnostics go to stderr.
Exit: 0 success/help, 1 integrity/read failure, 2 invalid options, 3 missing SDK.
`

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
export function contentDigest(snapshot) {
  const { contentDigest: _digest, ...content } = snapshot
  return hash(canonicalJson(content))
}
export function validateEntityReference(snapshot, schema, native) {
  const require = (condition, message) => { if (!condition) throw new Error(message) }
  const source = snapshot?.source
  require(snapshot?.schemaVersion === 1 && source?.platform === 'Windows' && source.scope === SCOPE && source.rights === RIGHTS, 'Invalid entity reference schema or scope')
  require(source.gameVersion === schema.source.gameVersion && source.gameVersion === native.source.gameVersion, 'Entity reference game version pin differs')
  require(source.gameExecutableSha256 === schema.source.gameExecutableSha256 && source.gameExecutableSha256 === native.source.executable.sha256 && source.editorExecutableSha256 === schema.source.editorExecutableSha256, 'Entity reference executable pin differs')
  for (const [key, path] of [['world', 'Content/Worlds/field.dat'], ['biomes', 'Content/Database/biome.dat']]) {
    require(source[key]?.path === path && HASH_PATTERN.test(source[key]?.sha256) && Number.isSafeInteger(source[key]?.size) && source[key].size > 0 && source[key].size <= MAX_BYTES, `Invalid entity ${key} source`)
  }
  require(source.world.sha256 === schema.source.entityWorldSha256, 'Entity reference world pin differs')
  const biomePin = native.source.files.find(file => file.path === 'Database/biome.dat')
  require(source.biomes.sha256 === biomePin?.sha256 && source.biomes.size === biomePin?.size, 'Entity reference biome pin differs')
  require(Array.isArray(source.evidence) && source.evidence.length > 0 && source.evidence.every(entry => typeof entry === 'string' && !entry.startsWith('/') && !entry.includes('\\')), 'Invalid portable entity evidence')
  require(Array.isArray(snapshot.records) && snapshot.records.length > 0 && snapshot.records.length <= 100_000, 'Invalid entity record array')
  const allowedKeys = ['ID', 'Name', 'NameSource', 'EntityType', 'BiomeID', 'BiomeName', 'Coord', 'NpcKey', 'NpcLinkedKey', 'NpcOutfitNames', 'NpcOutfitTextureKeys', 'JobID', 'SparkID', 'TroopIDs', 'LootType', 'LootValue', 'DoorType', 'RequiredItemID']
  const biomeNames = new Map((native.databases?.biome ?? []).filter(Boolean).map(record => [record.ID, record.Name]))
  const nameTypes = { 'NpcData.Key': 'Npc', 'NpcData.Outfits[0].Name': 'Npc', 'HomePointData.Name': 'HomePoint', 'MarkerData.Key': 'Marker', 'SignData.Title': 'Sign' }
  let previous = -1
  for (const record of snapshot.records) {
    require(record && Object.keys(record).every(key => allowedKeys.includes(key)), 'Unknown entity metadata field')
    require(isInt32(record.ID) && record.ID > previous, 'Duplicate or unordered entity ID')
    previous = record.ID
    require(TYPES.includes(record.EntityType) && typeof record.Name === 'string' && record.Name.length > 0 && NAME_SOURCES.includes(record.NameSource), 'Invalid entity type or label')
    require(record.NameSource === 'EntityType' ? record.Name === record.EntityType : nameTypes[record.NameSource] === record.EntityType, 'Entity label source differs from type')
    if (record.NameSource === 'NpcData.Key') require(record.Name === record.NpcKey, 'Entity NPC key label differs')
    if (record.NameSource === 'NpcData.Outfits[0].Name') require(record.Name === record.NpcOutfitNames?.[0], 'Entity NPC outfit label differs')
    require(Number.isInteger(record.BiomeID) && record.BiomeID >= 0 && record.BiomeID <= 255 && typeof record.BiomeName === 'string', 'Invalid entity biome')
    require(biomeNames.get(record.BiomeID) === record.BiomeName, 'Entity biome label differs from pinned native definitions')
    require(record.Coord && Object.keys(record.Coord).sort().join(',') === 'X,Y,Z' && Object.values(record.Coord).every(isInt32), 'Invalid entity coordinates')
    for (const key of ['NpcKey', 'NpcLinkedKey']) if (key in record) require(record[key] === null || typeof record[key] === 'string', `Invalid entity ${key}`)
    for (const key of ['NpcOutfitNames', 'NpcOutfitTextureKeys']) if (key in record) require(Array.isArray(record[key]) && record[key].every(value => value === null || typeof value === 'string'), `Invalid entity ${key}`)
    for (const key of ['JobID', 'RequiredItemID', 'SparkID', 'LootValue']) if (key in record) require(record[key] === null || isInt32(record[key]), `Invalid entity ${key}`)
    if ('TroopIDs' in record) require(Array.isArray(record.TroopIDs) && record.TroopIDs.every(isInt32), 'Invalid entity troop references')
    if ('LootType' in record) require(['Nothing', 'Currency', 'Item', 'Equipment'].includes(record.LootType), 'Invalid entity loot type')
    if ('DoorType' in record) require(typeof record.DoorType === 'string' && record.DoorType.length > 0, 'Invalid entity door type')
  }
  require(HASH_PATTERN.test(snapshot.contentDigest) && snapshot.contentDigest === contentDigest(snapshot), 'Entity reference content digest differs')
}
async function pins() {
  return Promise.all(['src/mod-inspector/reference-schema.json', 'src/catalog/native-game-data.json'].map(path => readFile(join(ROOT, path), 'utf8').then(JSON.parse)))
}
async function boundedRead(path) {
  const bytes = await readFile(path)
  if (bytes.length > MAX_BYTES) throw new Error('Source exceeds size limit')
  return bytes
}
export async function extractEntityReference(input, acquisition = false) {
  const installation = basename(resolve(input)).toLowerCase() === 'content' ? dirname(resolve(input)) : resolve(input)
  const [schema, native] = await pins()
  const [game, editor, world, biomes] = await Promise.all(['Crystal Project.exe', 'Crystal Edit/Crystal Edit.exe', 'Content/Worlds/field.dat', 'Content/Database/biome.dat'].map(path => boundedRead(join(installation, path))))
  const version = parseGameExecutableVersion(game).gameVersion
  if (version !== schema.source.gameVersion || hash(game) !== schema.source.gameExecutableSha256 || hash(game) !== native.source.executable.sha256 || hash(editor) !== schema.source.editorExecutableSha256) throw new Error('Installed executable fingerprints differ from reviewed source pins')
  const biomePin = native.source.files.find(file => file.path === 'Database/biome.dat')
  if (hash(world) !== schema.source.entityWorldSha256) throw new Error('Installed world fingerprint differs from reviewed source pin')
  if (hash(biomes) !== biomePin?.sha256 || biomes.length !== biomePin?.size) throw new Error('Installed biome fingerprint differs from native snapshot')
  let sdks
  try { sdks = execFileSync('dotnet', ['--list-sdks'], { encoding: 'utf8', timeout: 10_000, env: DOTNET_ENV }) }
  catch { const error = new Error('.NET SDK 10 is required for entity updates'); error.exitCode = 3; throw error }
  if (!/^10\./m.test(sdks)) { const error = new Error('.NET SDK 10 is required for entity updates'); error.exitCode = 3; throw error }
  const temporary = await mkdtemp(join(tmpdir(), 'crykit-entity-reference-'))
  try {
    await cp(join(ROOT, 'scripts/entity-reference-exporter'), join(temporary, 'exporter'), { recursive: true })
    const assembly = Buffer.from(game)
    const pe = assembly.readUInt32LE(0x3c)
    if (assembly.readUInt16LE(pe + 4) !== 0x8664) throw new Error('Reviewed assembly has unexpected architecture')
    if (process.arch === 'arm64') assembly.writeUInt16LE(0xaa64, pe + 4)
    else if (process.arch !== 'x64') throw new Error('Entity exporter requires an x64 or ARM64 host')
    const assemblyPath = join(temporary, 'Crystal Project.exe')
    const projectionPath = join(temporary, 'records.json')
    await writeFile(assemblyPath, assembly)
    console.error('Extracting field metadata with the fingerprinted installed game decoder')
    execFileSync('dotnet', ['run', '--project', join(temporary, 'exporter'), '--verbosity', 'quiet', '--', installation, assemblyPath, projectionPath, ...(acquisition ? ['acquisition'] : [])], { encoding: 'utf8', maxBuffer: MAX_BYTES, timeout: 120_000, env: DOTNET_ENV, stdio: ['ignore', 'pipe', 'pipe'] })
    const biomeRecords = parseGameDatabase(biomes, 'biome').records
    const biomeNames = new Map(biomeRecords.filter(Boolean).map(record => [record.ID, record.Name]))
    const records = JSON.parse(await readFile(projectionPath, 'utf8')).map(record => ({ ...record, BiomeName: biomeNames.get(record.BiomeID) }))
    const source = { platform: 'Windows', gameVersion: version, gameExecutableSha256: hash(game), editorExecutableSha256: hash(editor), world: { path: 'Content/Worlds/field.dat', sha256: hash(world), size: world.length }, biomes: { path: 'Content/Database/biome.dat', sha256: hash(biomes), size: biomes.length }, scope: SCOPE, rights: RIGHTS, evidence: ['SangEdit.Utilities.PathHelper.GetWorldDataPath', 'SangEdit.Models.Entities.EntityManager.Load/TryLoadBinary/LoadEntityData', 'SangEdit.Models.Entities.EntitySerializer.Deserialize', 'SangEdit.Models.Entities.ModelEntityData.Header', 'Sang.SangEntity.EntitySerializer.Deserialize', 'Sang.Voxel.ZLookup.LoadBinary', 'Sang.Voxel.EntityLedger.LoadLedger', 'Content/Worlds/field.dat embedded entity ledger ID and coordinate equality', 'Content/Database/biome.dat ID and Name'] }
    return { source, records }
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
async function update(input) {
  const { source, records } = await extractEntityReference(input)
  const [schema, native] = await pins()
  const snapshot = { schemaVersion: 1, contentDigest: '', source, records }
  snapshot.contentDigest = contentDigest(snapshot)
  validateEntityReference(snapshot, schema, native)
  const output = `${JSON.stringify(snapshot, null, 2).replace(/[\u2014\u2018\u2019\u201c\u201d]/g, char => `\\u${char.charCodeAt(0).toString(16)}`).replace(/@(?=Astley\.Name)/g, '\\u0040')}\n`
  await writeFile(`${OUTPUT}.tmp`, output)
  await rename(`${OUTPUT}.tmp`, OUTPUT)
  console.log(`Saved Windows ${source.gameVersion} field entity metadata with source fingerprints (${records.length} records)`)
}
async function main() {
  let values
  try {
    values = parseArgs({ options: { input: { type: 'string', short: 'i' }, check: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } }, strict: true }).values
    if (values.help) { process.stdout.write(USAGE); return }
    if (values.check && values.input !== undefined) throw new Error('--check cannot be combined with --input')
    if (!values.check && !values.input?.trim()) throw new Error('--input is required when updating entity references')
  } catch (error) { console.error(error.message); process.exitCode = 2; return }
  try {
    if (values.check) {
      const [schema, native] = await pins()
      const snapshot = JSON.parse(await readFile(OUTPUT, 'utf8'))
      validateEntityReference(snapshot, schema, native)
      console.log(`Verified Windows ${snapshot.source.gameVersion} field entity metadata, source pins, and content digest (${snapshot.records.length} records)`)
    } else await update(values.input)
  } catch (error) { console.error(error.message); process.exitCode = error.exitCode ?? 1 }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
