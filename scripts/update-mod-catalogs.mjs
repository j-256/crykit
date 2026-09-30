#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EQUIPMENT_OUTPUT = join(ROOT, 'src/catalog/equipment-expansion.json')
const INNATE_OUTPUT = join(ROOT, 'src/catalog/learnable-innates.json')
const SPRITE_MANIFEST_OUTPUT = join(ROOT, 'src/catalog/mod-sprites.json')
const SPRITE_OUTPUT_DIR = join(ROOT, 'src/assets/mod-sprites')
const SUPPORTED_FAMILIES = Object.freeze(['Equipment', 'Abilities', 'Statuses', 'Recipes', 'Items', 'Monsters'])
const EQUIPMENT_TYPES = Object.freeze(['Sword', 'Axe', 'Dagger', 'Rapier', 'Katana', 'Spear', 'Scythe', 'Bow', 'Staff', 'Wand', 'Book', 'Shield', 'Heavy Head', 'Medium Head', 'Light Head', 'Heavy Body', 'Medium Body', 'Light Body', 'Accessory'])
const CELL_SIZE = 34
const CELL_COLUMNS = 7
const ARCHIVE_FIXED_HEADER_BYTES = 6
const ARCHIVE_TIMESTAMP_BYTES = 7
const MAX_ARCHIVE_NAME_BYTES = 256
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex')

// Names are from Crystal Edit 1.2.9's ModelStatModTag enum
export const STAT_MOD_TAG_NAMES = Object.freeze({
  0: 'Flat_HP', 1: 'Flat_MP', 2: 'Flat_AP', 6: 'Flat_Str', 7: 'Flat_Vit', 8: 'Flat_Dex', 9: 'Flat_Agi', 10: 'Flat_Mnd', 11: 'Flat_Spi', 12: 'Flat_Spd', 13: 'Flat_Lck', 14: 'Flat_AllStats',
  20: 'Addi_HP', 21: 'Addi_MP', 26: 'Addi_Str', 27: 'Addi_Vit', 28: 'Addi_Dex', 29: 'Addi_Agi', 30: 'Addi_Mnd', 31: 'Addi_Spi', 32: 'Addi_Spd', 33: 'Addi_Lck',
  40: 'Flat_PAtk', 41: 'Flat_PPen', 42: 'Flat_PDef', 43: 'Addi_PCritChance', 44: 'Addi_PCritDmg', 45: 'Flat_PAccRating', 46: 'Flat_PEvaRating', 47: 'Flat_MPen', 48: 'Flat_MDef', 50: 'Mult_PHitChance_Given_100', 53: 'Flat_CritResist',
  60: 'Addi_PAtk', 61: 'Addi_PPen', 62: 'Addi_PDef', 65: 'Addi_PAccRating', 66: 'Addi_PEvaRating', 67: 'Addi_MPen', 68: 'Addi_MDef', 80: 'Addi_PVariance', 81: 'PElement', 82: 'PStatusApply',
  100: 'Flat_HP_PerLevel', 101: 'Flat_MP_PerLevel', 106: 'Flat_Str_PerLevel', 107: 'Flat_Vit_PerLevel', 108: 'Flat_Dex_PerLevel', 109: 'Flat_Agi_PerLevel', 110: 'Flat_Mnd_PerLevel', 111: 'Flat_Spi_PerLevel', 112: 'Flat_Spd_PerLevel', 113: 'Flat_Lck_PerLevel', 140: 'Flat_PAtk_PerLevel', 142: 'Flat_PDef_PerLevel', 145: 'Flat_PAccRating_PerLevel', 146: 'Flat_PEvaRating_PerLevel', 147: 'Flat_MPen_PerLevel', 148: 'Flat_MDef_PerLevel',
  150: 'Flat_HP_PerTurn', 151: 'Flat_MP_PerTurn', 152: 'Flat_AP_PerTurn', 156: 'Flat_Str_PerTurn', 157: 'Flat_Vit_PerTurn', 158: 'Flat_Dex_PerTurn', 159: 'Flat_Agi_PerTurn', 160: 'Flat_Mnd_PerTurn', 161: 'Flat_Spi_PerTurn', 163: 'Flat_Lck_PerTurn', 170: 'Flat_PAtk_PerTurn', 172: 'Flat_PDef_PerTurn', 173: 'Addi_PCritChance_PerTurn', 176: 'Flat_PEvaRating_PerTurn', 178: 'Flat_MDef_PerTurn',
  200: 'Mult_PDmg_Given_100', 201: 'Mult_PDmg_Taken_100', 202: 'Mult_MDmg_Given_100', 203: 'Mult_MDmg_Taken_100', 206: 'PEva_Always', 207: 'PEva_Never', 208: 'Mute', 209: 'Mult_PCritDmg_Given_100', 210: 'Mult_PCritDmg_Taken_100', 211: 'Mult_PCritChance_Given_100', 213: 'Flat_PCritDmg_Given', 215: 'Mult_Healing_Given_100', 216: 'Mult_Healing_Taken_100', 217: 'Mult_MPCosts', 218: 'MEva_Always', 220: 'Mult_RepeatActionDmg', 226: 'Mult_PercentDmg_Taken_100', 228: 'Mult_PNonCritDmg_Given_100',
  241: 'Addi_DamagePerTurnHP', 242: 'Flat_DamagePerTurnMP', 243: 'Addi_DamagePerTurnMP', 244: 'Flat_DamagePerTurnAP', 246: 'Mult_DamagePerTurn_Taken_100', 250: 'APBonus_OnBattleStart', 251: 'APBonus_OnTurn', 252: 'APBonus_OnAttack', 253: 'APBonus_OnDamaged', 260: 'Mult_ThreatGain', 269: 'Mult_CT_100', 270: 'Mult_TT_NextTurn_100', 271: 'Addi_PDmgReturn', 272: 'Addi_PDmgReturn_OnKill', 273: 'Addi_MDmgReturn', 274: 'Addi_MDmgReturn_OnKill', 275: 'Flat_PDmgReturn', 300: 'Mult_HP', 330: 'MaxDamageTaken',
  400: 'Mult_ElementDmg_Taken', 401: 'StatusImmunity', 402: 'StatusAuto', 403: 'Reaction', 405: 'Mult_ElementDmg_Given', 406: 'EnableEquipType', 411: 'Flat_BuffDuration', 412: 'Flat_DebuffDuration', 413: 'Flat_ApplyBuffDuration', 414: 'Flat_ApplyDebuffDuration', 471: 'SetStatusAfterRemoval', 475: 'DisableLifestealAndRegen', 476: 'Mult_AbilityDmg', 477: 'RevealStatsAuto', 482: 'Flat_Cooldowns', 483: 'Flat_AbilityMPCost', 487: 'ReplaceAttackWith', 498: 'PerfectHit', 499: 'GetNextTurnWhenCritical', 510: 'TwoHanded', 515: 'Mult_PDefAtFullHP', 517: 'ImmuneToMPDmg', 525: 'LootChanceUp', 526: 'StealChanceUp', 529: 'RandomizeTarget', 540: 'DamageHitsMDef', 545: 'SetStatusAfterExpiry', 546: 'CritNever', 563: 'DmgTakenWhileCharging',
})

const HELP = `Usage:
  node scripts/update-mod-catalogs.mjs --check
  node scripts/update-mod-catalogs.mjs --equipment-json PATH --equipment-assets DIR --base-equipment-archive PATH --learnable-innates-json PATH

Generate and validate bundled Equipment Expansion and Learnable Innate Skills data.

Options:
  -c, --check                         Validate committed generated data and sprites
  -e, --equipment-json PATH           Equipment Expansion Crystal Edit JSON export
  -a, --equipment-assets DIR          Equipment Expansion custom-content directory
  -b, --base-equipment-archive PATH   Crystal Project Content/Textures/Equipment.dat
  -l, --learnable-innates-json PATH   Learnable Innate Skills Crystal Edit JSON export
  -h, --help                          Show this help

Update mode requires all four source options. Source paths may be absolute or relative and are never written to generated files. Check mode needs no private source files.

Exit statuses:
  0  Success
  1  Generation or validation failure
  2  Invalid usage or source precondition
  3  Missing conditional dependency
`

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function json(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function projectSource(root, digest) {
  assert(typeof root.ID === 'string' && root.ID, 'Crystal Edit project ID is missing')
  assert(typeof root.Title === 'string' && root.Title, 'Crystal Edit project title is missing')
  assert(typeof root.Version === 'string' && root.Version, 'Crystal Edit project version is missing')
  assert(Number.isSafeInteger(root.EditorVersion), 'Crystal Edit editor version is missing')
  return {
    projectId: root.ID,
    title: root.Title,
    author: typeof root.Author === 'string' ? root.Author : null,
    version: root.Version,
    editorVersion: root.EditorVersion,
    timestamp: typeof root.Timestamp === 'string' ? root.Timestamp : null,
    sha256: digest,
    steamWorkshopFileId: typeof root.SteamWorkshopFileID === 'string' || typeof root.SteamWorkshopFileID === 'number' ? String(root.SteamWorkshopFileID) : null,
  }
}

function slug(value) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function entityId(family, name) {
  const kinds = { Equipment: 'item', Abilities: 'ability', Statuses: 'status', Recipes: 'recipe', Items: 'item', Monsters: 'monster' }
  return `equipment-expansion:${kinds[family]}:${slug(name)}`
}

function validateModelFamily(root, family) {
  const records = root[family]
  assert(Array.isArray(records), `${family} must be an array`)
  const ids = new Set()
  const entityIds = new Set()
  for (const [index, record] of records.entries()) {
    assert(record && typeof record === 'object' && !Array.isArray(record), `${family}[${index}] must be an object`)
    assert(Number.isSafeInteger(record.ID) && record.ID >= 0, `${family}[${index}] has an invalid ID`)
    assert(typeof record.Name === 'string' && record.Name.trim(), `${family}[${index}] has an invalid name`)
    assert(!ids.has(record.ID), `${family} contains duplicate ID ${record.ID}`)
    const id = entityId(family, record.Name)
    assert(!entityIds.has(id), `${family} contains a duplicate normalized identity ${id}`)
    ids.add(record.ID)
    entityIds.add(id)
    for (const modifier of Array.isArray(record.StatMods) ? record.StatMods : []) {
      assert(modifier && typeof modifier === 'object' && Number.isSafeInteger(modifier.Tag), `${family}[${index}] has an invalid StatMod`)
      assert(STAT_MOD_TAG_NAMES[modifier.Tag], `${family}[${index}] uses unmapped StatMod tag ${modifier.Tag}`)
    }
  }
  return records
}

function normalizeEquipmentExport(root, digest) {
  const families = Object.fromEntries(SUPPORTED_FAMILIES.map(family => [family, validateModelFamily(root, family)]))
  for (const [index, record] of families.Equipment.entries()) {
    assert(Number.isSafeInteger(record.EquipmentType) && EQUIPMENT_TYPES[record.EquipmentType], `Equipment[${index}] has an invalid EquipmentType`)
    assert(typeof record.TexturePath === 'string' && Number.isSafeInteger(record.TextureIndex) && record.TextureIndex >= 0, `Equipment[${index}] has an invalid texture reference`)
  }
  return {
    schemaVersion: 1,
    source: projectSource(root, digest),
    equipmentTypes: EQUIPMENT_TYPES,
    statModTags: STAT_MOD_TAG_NAMES,
    families,
  }
}

function normalizeInnateExport(root, digest) {
  assert(Array.isArray(root.Jobs), 'Jobs must be an array')
  assert(Array.isArray(root.Passives), 'Passives must be an array')
  const jobs = root.Jobs
  const innates = root.Passives.filter(passive => passive?.IsInnate === true && passive?.IsLearnable === true)
  const normalized = innates.map((passive, index) => {
    assert(Number.isSafeInteger(passive.ID) && typeof passive.Name === 'string' && passive.Name.trim(), `Learnable passive ${index} is invalid`)
    assert(Number.isSafeInteger(passive.PP) && passive.PP >= 0, `${passive.Name} has an invalid PP cost`)
    assert(Number.isSafeInteger(passive.JP) && passive.JP >= 0, `${passive.Name} has an invalid JP cost`)
    const owners = jobs.filter(job => Array.isArray(job.PassiveIDs) && job.PassiveIDs.includes(passive.ID))
    assert(owners.length === 1, `${passive.Name} must belong to exactly one job`)
    const job = owners[0]
    const positions = []
    for (const [column, cells] of (job.LearnTree ?? []).entries()) {
      assert(Array.isArray(cells), `${job.Name} has an invalid LearnTree column`)
      for (const [row, cell] of cells.entries()) if (cell?.NodeType === 3 && cell.DataID === passive.ID) positions.push({ column: column + 1, row: row + 1, prerequisites: { left: Boolean(cell.PrereqLeft), middle: Boolean(cell.PrereqMiddle), right: Boolean(cell.PrereqRight) } })
    }
    assert(positions.length === 1, `${passive.Name} must have exactly one learn-tree position`)
    return { classId: job.ID, className: job.Name, passive, positions }
  })
  assert(normalized.length > 0, 'No learnable innate passives were found')
  return { schemaVersion: 1, source: projectSource(root, digest), innates: normalized }
}

export function parseEquipmentArchive(bytes) {
  assert(Buffer.isBuffer(bytes) && bytes.length >= ARCHIVE_FIXED_HEADER_BYTES, 'Base equipment archive is truncated')
  assert(bytes.readUInt16LE(0) === 0 && bytes.readUInt16LE(4) === 0, 'Base equipment archive header is unsupported')
  const entryCount = bytes.readUInt16LE(2)
  assert(entryCount > 0, 'Base equipment archive contains no entries')
  let offset = ARCHIVE_FIXED_HEADER_BYTES + entryCount * ARCHIVE_TIMESTAMP_BYTES
  assert(offset <= bytes.length, 'Base equipment archive timestamp table is truncated')
  const sheets = new Map()
  for (let index = 0; index < entryCount; index += 1) {
    assert(offset + 4 <= bytes.length, `Base equipment archive entry ${index} has no name length`)
    const nameLength = bytes.readInt32LE(offset)
    offset += 4
    assert(nameLength > 0 && nameLength <= MAX_ARCHIVE_NAME_BYTES && offset + nameLength + 4 <= bytes.length, `Base equipment archive entry ${index} has an invalid name`)
    const name = bytes.subarray(offset, offset + nameLength).toString('utf8')
    offset += nameLength
    const dataLength = bytes.readInt32LE(offset)
    offset += 4
    assert(dataLength >= PNG_SIGNATURE.length && offset + dataLength <= bytes.length, `Base equipment archive entry ${name} has an invalid size`)
    const png = bytes.subarray(offset, offset + dataLength)
    offset += dataLength
    assert(png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE), `Base equipment archive entry ${name} is not a PNG`)
    assert(!sheets.has(name), `Base equipment archive contains duplicate entry ${name}`)
    sheets.set(name, png)
  }
  assert(offset === bytes.length, 'Base equipment archive contains trailing data')
  return sheets
}

async function spriteManifest(data, assetRoot, baseArchiveBytes, baseArchiveDigest, sharp) {
  const baseSheets = parseEquipmentArchive(baseArchiveBytes)
  const assets = {}
  const entities = {}
  const files = new Map()
  for (const record of data.families.Equipment) {
    const textureName = record.TexturePath.split('/').at(-1)
    const input = join(assetRoot, 'Equipment', `${textureName}.png`)
    const custom = existsSync(input)
    const sourceBytes = custom ? input : baseSheets.get(textureName)
    assert(sourceBytes, `${record.Name} references unavailable equipment sheet ${textureName}`)
    const left = record.TextureIndex % CELL_COLUMNS * CELL_SIZE
    const top = Math.floor(record.TextureIndex / CELL_COLUMNS) * CELL_SIZE
    const image = sharp(sourceBytes, { animated: false })
    const metadata = await image.metadata()
    assert(metadata.width >= left + CELL_SIZE && metadata.height >= top + CELL_SIZE, `${record.Name} references an out-of-bounds cell in ${textureName}.png`)
    const bytes = await image.extract({ left, top, width: CELL_SIZE, height: CELL_SIZE }).png({ compressionLevel: 9 }).toBuffer()
    const digest = sha256(bytes)
    const file = `${digest}.png`
    files.set(file, bytes)
    assets[digest] = {
      file,
      sha256: digest,
      title: 'Crystal Project equipment sprite',
      width: CELL_SIZE,
      height: CELL_SIZE,
      license: 'Copyrighted third-party artwork',
    }
    const id = entityId('Equipment', record.Name)
    entities[id] = {
      kind: 'item',
      name: record.Name,
      asset: digest,
      origin: custom ? 'mod-export' : 'base-game-archive',
      sources: [custom
        ? { title: `${data.source.title} v${data.source.version}`, locator: `${record.TexturePath}, cell ${record.TextureIndex}`, applicability: 'Exact custom sprite from the supplied PC mod export; Nintendo Switch appearance is unverified' }
        : { title: 'Crystal Project base equipment texture archive', locator: `Content/Textures/Equipment.dat > ${textureName}, cell ${record.TextureIndex}`, applicability: 'Exact reused base-game sprite from the locally supplied archive; game version and Nintendo Switch appearance are unverified' }],
    }
  }
  return { manifest: { schemaVersion: 2, source: data.source, baseGameSource: { title: 'Crystal Project base equipment texture archive', locator: 'Content/Textures/Equipment.dat', sha256: baseArchiveDigest, format: 'Version 0 texture archive with seven-byte entry timestamps and length-prefixed PNG payloads' }, assets, entities }, files }
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function loadSharp() {
  try {
    return (await import('sharp')).default
  } catch {
    const error = new Error('The sharp dependency is required for sprite generation and validation')
    error.exitCode = 3
    throw error
  }
}

async function update(options) {
  const equipmentBytes = await readFile(resolve(options.equipmentJson))
  const innateBytes = await readFile(resolve(options.learnableInnatesJson))
  const baseArchiveBytes = await readFile(resolve(options.baseEquipmentArchive))
  const equipment = normalizeEquipmentExport(json(equipmentBytes, 'Equipment Expansion export'), sha256(equipmentBytes))
  const innates = normalizeInnateExport(json(innateBytes, 'Learnable Innate Skills export'), sha256(innateBytes))
  const sharp = await loadSharp()
  const sprites = await spriteManifest(equipment, resolve(options.equipmentAssets), baseArchiveBytes, sha256(baseArchiveBytes), sharp)
  await mkdir(SPRITE_OUTPUT_DIR, { recursive: true })
  const existing = (await readdir(SPRITE_OUTPUT_DIR)).filter(file => file.endsWith('.png'))
  for (const file of existing) if (!sprites.files.has(file)) await unlink(join(SPRITE_OUTPUT_DIR, file))
  for (const [file, bytes] of sprites.files) await writeFile(join(SPRITE_OUTPUT_DIR, file), bytes)
  await writeJson(EQUIPMENT_OUTPUT, equipment)
  await writeJson(INNATE_OUTPUT, innates)
  await writeJson(SPRITE_MANIFEST_OUTPUT, sprites.manifest)
  return { equipment: equipment.families.Equipment.length, innates: innates.innates.length, sprites: Object.keys(sprites.manifest.entities).length }
}

async function validateCommitted() {
  const equipment = json(await readFile(EQUIPMENT_OUTPUT), relative(ROOT, EQUIPMENT_OUTPUT))
  const innates = json(await readFile(INNATE_OUTPUT), relative(ROOT, INNATE_OUTPUT))
  const manifest = json(await readFile(SPRITE_MANIFEST_OUTPUT), relative(ROOT, SPRITE_MANIFEST_OUTPUT))
  assert(equipment.schemaVersion === 1 && innates.schemaVersion === 1 && manifest.schemaVersion === 2, 'Generated mod catalog schema version is unsupported')
  assert(equipment.source.sha256 === manifest.source.sha256, 'Equipment data and sprite manifest source digests differ')
  assert(/^[a-f0-9]{64}$/.test(equipment.source.sha256) && /^[a-f0-9]{64}$/.test(innates.source.sha256) && /^[a-f0-9]{64}$/.test(manifest.baseGameSource?.sha256), 'Generated source digest is invalid')
  for (const family of SUPPORTED_FAMILIES) validateModelFamily(equipment.families, family)
  assert(Array.isArray(innates.innates) && innates.innates.length > 0, 'Generated learnable innate data is empty')
  const equipmentById = new Map(equipment.families.Equipment.map(record => [entityId('Equipment', record.Name), record]))
  const expectedFiles = new Set()
  const sharp = await loadSharp()
  for (const [id, binding] of Object.entries(manifest.entities)) {
    assert(equipmentById.has(id), `Sprite binding ${id} has no equipment definition`)
    assert(binding.kind === 'item' && binding.name === equipmentById.get(id).Name, `Sprite binding ${id} has the wrong identity`)
    const asset = manifest.assets[binding.asset]
    assert(asset && asset.file === `${binding.asset}.png` && asset.sha256 === binding.asset, `Sprite binding ${id} has an invalid asset`)
    const path = join(SPRITE_OUTPUT_DIR, asset.file)
    const bytes = await readFile(path)
    assert(sha256(bytes) === binding.asset, `Sprite asset ${asset.file} does not match its digest`)
    const metadata = await sharp(bytes).metadata()
    assert(metadata.width === CELL_SIZE && metadata.height === CELL_SIZE, `Sprite asset ${asset.file} is not ${CELL_SIZE}x${CELL_SIZE}`)
    expectedFiles.add(asset.file)
  }
  assert(Object.keys(manifest.entities).length === equipmentById.size, 'Not every Equipment Expansion definition has an exact sprite binding')
  const actualFiles = new Set((await readdir(SPRITE_OUTPUT_DIR)).filter(file => file.endsWith('.png')))
  assert(actualFiles.size === expectedFiles.size && [...actualFiles].every(file => expectedFiles.has(file)), 'Generated sprite directory contains missing or unexpected PNG files')
  const serialized = JSON.stringify({ equipment, innates, manifest })
  const machineRoot = '/' + 'Users' + '/'
  const windowsRoot = '\\' + 'Users' + '\\'
  assert(!serialized.includes(machineRoot) && !serialized.includes(windowsRoot), 'Generated data contains a private machine path')
  return { equipment: equipment.families.Equipment.length, innates: innates.innates.length, sprites: Object.keys(manifest.entities).length }
}

export async function main(argv = process.argv.slice(2)) {
  let values
  try {
    ;({ values } = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
        check: { type: 'boolean', short: 'c' },
        'equipment-json': { type: 'string', short: 'e' },
        'equipment-assets': { type: 'string', short: 'a' },
        'base-equipment-archive': { type: 'string', short: 'b' },
        'learnable-innates-json': { type: 'string', short: 'l' },
        help: { type: 'boolean', short: 'h' },
      },
    }))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 2
  }
  if (values.help) {
    process.stdout.write(HELP)
    return 0
  }
  const options = {
    equipmentJson: values['equipment-json'],
    equipmentAssets: values['equipment-assets'],
    baseEquipmentArchive: values['base-equipment-archive'],
    learnableInnatesJson: values['learnable-innates-json'],
  }
  const sourceOptions = [options.equipmentJson, options.equipmentAssets, options.baseEquipmentArchive, options.learnableInnatesJson]
  if (values.check && sourceOptions.some(Boolean)) {
    console.error('--check cannot be combined with source options')
    return 2
  }
  if (!values.check && sourceOptions.some(value => !value)) {
    console.error('Update mode requires --equipment-json, --equipment-assets, --base-equipment-archive, and --learnable-innates-json')
    return 2
  }
  try {
    const result = values.check ? await validateCommitted() : await update(options)
    process.stdout.write(`${values.check ? 'Validated' : 'Generated'} ${result.equipment} equipment definitions, ${result.innates} learnable innates, and ${result.sprites} exact sprites\n`)
    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return error && typeof error === 'object' && 'exitCode' in error ? error.exitCode : values.check ? 1 : 2
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main()
