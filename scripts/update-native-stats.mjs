#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { parseStarterRecords } from './game-assets.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OUTPUT = join(ROOT, 'src/catalog/native-stats-v1.json')
const EXECUTABLE_SHA256 = '36f7d413160a4deee36b47fc6ac534e87cadb6f23f57337d4630ec99cedb14e6'
const FAMILIES = ['job', 'equipment', 'passive', 'gender', 'ability', 'status', 'system', 'patch']
const FIELDS = {
  job: ['ID', 'Name', 'HPRating', 'MPRating', 'StrRating', 'VitRating', 'DexRating', 'AgiRating', 'MndRating', 'SpiRating', 'SpdRating', 'LckRating', 'PassiveIDs', 'EquipmentTypes'],
  equipment: ['ID', 'Name', 'EquipmentType', 'IsTwoHanded', 'IsOneOnly', 'StatMods'],
  passive: ['ID', 'Name', 'IsInnate', 'IsLearnable', 'PP', 'StatMods'],
  gender: ['ID', 'Name', 'BoostHP', 'BoostMP', 'BoostStr', 'BoostVit', 'BoostDex', 'BoostAgi', 'BoostMnd', 'BoostSpi', 'BoostSpd', 'BoostLck'],
  ability: ['ID', 'Name', 'JP', 'HPCost', 'MPCost', 'APCost', 'CTCost', 'CDCost', 'Scope', 'Target', 'EnabledWeaponTypes', 'EnabledUnarmed', 'Attribute', 'IsPAbil', 'IsMAbil', 'IsBasic', 'PDefAsPAtk', 'StrRate', 'VitRate', 'DexRate', 'AgiRate', 'MndRate', 'SpiRate', 'SpdRate', 'LckRate', 'ScalingPAtkRate', 'ScalingPower', 'BasePAtkRate', 'BasePower', 'BaseAcc', 'BaseCritChance', 'BaseCritDmg', 'BaseVar', 'PDefRate', 'MDefRate', 'Element', 'TargetStatuses', 'UserStatuses', 'AbilityMods'],
  status: ['ID', 'Name', 'Category', 'StatMods'],
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const project = (family, records) => records.filter(Boolean).map(record => Object.fromEntries(FIELDS[family].filter(field => Object.hasOwn(record, field)).map(field => [field, record[field]])))
const USAGE = `Usage: node scripts/update-native-stats.mjs [-i <game-installation-directory>]
       node scripts/update-native-stats.mjs --check
Project versioned numeric inputs from the shared bundled PC 1.6.9.0 snapshot.
Optional input verifies Crystal Project.exe and Content/Database/*.dat against it.
Requires Node.js; extraction needs no installation or network access.
Native IDs use the pinned identity crosswalk; passive bindings require an explicit
wiki class plus membership in that native job. No descriptions or local paths are saved.
  -i, --input <directory>  Verify the matching installation while projecting
      --check              Validate the committed snapshot offline
  -h, --help               Show help
Results go to stdout; errors go to stderr. Exit: 0 success, 1 runtime/integrity,
2 invalid options. No network requests or game-save reads are made.
`
let values
try {
  values = parseArgs({ options: { input: { type: 'string', short: 'i' }, check: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } }, strict: true }).values
  if (values.help) { process.stdout.write(USAGE); process.exit(0) }
  if (values.check && values.input !== undefined || values.input !== undefined && !values.input.trim()) throw new Error('Use --check separately or a nonempty --input directory')
} catch (error) { console.error(error.message); process.exit(2) }

function validate(snapshot) {
  const { checksum, ...content } = snapshot
  if (snapshot.schemaVersion !== 1 || snapshot.engine !== 'pc-1.6.9-v1' || snapshot.executableSha256 !== EXECUTABLE_SHA256 || checksum !== hash(JSON.stringify(content))) throw new Error('Native stat snapshot identity or checksum mismatch')
  for (const family of Object.keys(FIELDS)) {
    const records = snapshot.records[family]
    if (!Array.isArray(records) || new Set(records.map(record => record.ID)).size !== records.length || records.some(record => !Number.isSafeInteger(record.ID) || typeof record.Name !== 'string')) throw new Error(`Invalid ${family} records`)
  }
  for (const binding of Object.values(snapshot.bindings)) if (!snapshot.records[binding.family]?.some(record => record.ID === binding.id) || !binding.evidence) throw new Error('Invalid native identity binding')
}

try {
  const native = JSON.parse(await readFile(join(ROOT, 'src/catalog/native-game-data.json'), 'utf8'))
  const executableSha256 = native.source.executable.sha256
  if (executableSha256 !== EXECUTABLE_SHA256) throw new Error('Executable differs from the verified rules; create a new version instead of replacing this snapshot')
  const data = native.databases
  const inputs = {}
  for (const family of FAMILIES) {
    inputs[family] = native.source.files.find(file => file.path === `Database/${family}.dat`)?.sha256
    if (!inputs[family] || !data[family]) throw new Error(`Shared native snapshot lacks ${family} evidence`)
    if (values.input && hash(await readFile(join(values.input, 'Content/Database', `${family}.dat`))) !== inputs[family]) throw new Error(`Installed ${family} database differs from the bundled snapshot`)
  }
  if (values.input && hash(await readFile(join(values.input, 'Crystal Project.exe'))) !== executableSha256) throw new Error('Installed executable differs from the bundled snapshot')
  const rules = JSON.parse(await readFile(join(ROOT, 'src/calculations/pc-1.6.9-v1.json'), 'utf8'))
  for (const [tag, modifier] of Object.entries(rules.statMods)) if (native.enums.SangStatModTag[tag] !== modifier.name) throw new Error(`Stat modifier ${tag} differs from the verified executable enum`)
  const crosswalk = JSON.parse(await readFile(join(ROOT, 'src/catalog/game-identities.json'), 'utf8'))
  const wiki = JSON.parse(await readFile(join(ROOT, 'src/catalog/wiki-data.json'), 'utf8'))
  const starterSource = await readFile(join(ROOT, 'src/catalog/data.ts'), 'utf8')
  const starterRecords = parseStarterRecords(starterSource)
  const normalize = name => name.toLowerCase().trim().replace(/\s+/g, ' ')
  const bindings = {}
  for (const [entityId, mapping] of Object.entries(crosswalk.mappings)) {
    if (!FIELDS[mapping.database] || !data[mapping.database][mapping.databaseId]) continue
    bindings[entityId] = { family: mapping.database, id: mapping.databaseId, evidence: `Pinned native identity crosswalk: ${mapping.locator}` }
  }
  for (const entity of wiki.entities.filter(entity => ['passive', 'innate'].includes(entity.kind))) {
    const className = entity.fields.Class?.state === 'known' ? entity.fields.Class.value : undefined
    const jobBinding = Object.entries(crosswalk.mappings).find(([, mapping]) => mapping.database === 'job' && mapping.name === className)?.[1]
    if (!jobBinding) continue
    const job = data.job[jobBinding.databaseId]
    const candidates = job.PassiveIDs.map(id => data.passive[id]).filter(record => record && normalize(record.Name) === normalize(entity.name) && record.IsInnate === (entity.kind === 'innate'))
    if (candidates.length !== 1) continue
    bindings[entity.id] = { family: 'passive', id: candidates[0].ID, evidence: `Explicit ${className} wiki membership; native job ${job.ID} PassiveIDs; normalized passive label and exact innate flag` }
    for (const starter of starterRecords.filter(record => record.kind === entity.kind && normalize(record.name) === normalize(entity.name))) {
      bindings[starter.id] = { ...bindings[entity.id], evidence: `${bindings[entity.id].evidence}; starter catalog merges this wiki kind and normalized label` }
    }
  }
  const records = Object.fromEntries(Object.keys(FIELDS).map(family => [family, project(family, data[family])]))
  const patches = data.patch.map(patch => ({ name: patch.Name, records: Object.fromEntries(Object.keys(FIELDS).map(family => [family, project(family, patch[{ job: 'Jobs', equipment: 'Equipment', passive: 'Passives', gender: 'Genders', ability: 'Abilities', status: 'Statuses' }[family]])])) }))
  const content = { schemaVersion: 1, engine: 'pc-1.6.9-v1', gameVersion: '1.6.9.0', executableSha256, nativeDataDigest: native.contentDigest, inputs, crosswalkDigest: crosswalk.source.contentDigest, wikiDigest: wiki.contentDigest, starterDigest: hash(starterSource), catalogId: 'crystal-project-public-starter', battleConfig: data.system.BattleConfig, records, patches, bindings }
  const snapshot = { ...content, checksum: hash(JSON.stringify(content)) }
  validate(snapshot)
  if (values.check) {
    const existing = JSON.parse(await readFile(OUTPUT, 'utf8'))
    validate(existing)
    if (existing.checksum !== snapshot.checksum) throw new Error('Calculation projection differs from the shared native snapshot or identity sources; regenerate it')
    console.log('Verified versioned calculation projection against shared native game data')
  } else {
    const temporary = `${OUTPUT}.tmp`
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`)
    await rename(temporary, OUTPUT)
    console.log(`Saved native character-stat snapshot with ${Object.keys(bindings).length} explicit identity bindings`)
  }
} catch (error) { console.error(error.message); process.exitCode = 1 }
