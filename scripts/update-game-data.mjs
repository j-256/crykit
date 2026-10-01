#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { buildNativeCatalog, NATIVE_ENUM_TYPES, NATIVE_FAMILIES, NATIVE_SNAPSHOT_SCHEMA, validateNativeSnapshot } from '../src/domain/native-game.ts'
import { hash, parseGameDatabase } from './game-assets.mjs'
import { parseGameExecutableVersion } from './game-version.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OUTPUT = join(ROOT, 'src/catalog/native-game-data.json')
const IDENTITIES = join(ROOT, 'src/catalog/game-identities.json')
const CLASS_TREES = join(ROOT, 'src/catalog/class-tree-identities.json')
const MAX_SOURCE_BYTES = 32 * 1024 * 1024
const ENUM_NAMESPACE = 'Sang.SangData.SangDataEnums.'
const USAGE = `Usage: node --experimental-strip-types scripts/update-game-data.mjs -i|--input <Content> [-d|--decompiler <ilspycmd>] [-h|--help]
       node --experimental-strip-types scripts/update-game-data.mjs --check [-h|--help]
Generate the bundled native gameplay reference snapshot from a Crystal Project
Windows Content directory. The sibling Crystal Project.exe supplies verified
file, product, assembly version, and numeric enum labels. No game code is executed.
  -i, --input <Content>        Owned installation's Content directory
  -d, --decompiler <ilspycmd>  ILSpy CLI executable (default: ilspycmd on PATH)
      --check                 Verify the committed snapshot offline without writes
  -h, --help                  Show help
Update requires Node >=22.12, dotnet, ILSpy CLI, and the reviewed identity crosswalk.
Check requires only Node and committed files. No environment variables or network
requests are used. Machine paths and executable bytes are never bundled.
Results go to stdout; progress and errors go to stderr.
Exit: 0 success/help, 1 integrity/read failure, 2 invalid options, 3 missing decompiler.
`

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

export function parseEnumSource(source, type) {
  const body = new RegExp(`\\benum ${type}\\s*\\{([^}]+)\\}`).exec(source)?.[1]
  if (!body) throw new Error(`Executable enum ${type} is absent`)
  const result = {}
  let value = -1
  for (const entry of body.split(',').map(part => part.trim()).filter(Boolean)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:\s*=\s*(-?\d+))?$/.exec(entry)
    if (!match) throw new Error(`Executable enum ${type} has an unsupported value`)
    value = match[2] === undefined ? value + 1 : Number(match[2])
    if (!Number.isSafeInteger(value) || result[value]) throw new Error(`Executable enum ${type} is ambiguous`)
    result[value] = match[1]
  }
  return result
}

export function identityBindingsFor(manifest, databases, classTrees = { classes: {} }) {
  const bindings = {}
  for (const [id, mapping] of Object.entries(manifest.mappings)) {
    const key = `${mapping.database}:${mapping.databaseId}`
    if (!databases[mapping.database]?.some(record => record?.ID === mapping.databaseId)) continue
    if (bindings[key] && bindings[key] !== id) throw new Error(`Identity crosswalk has multiple catalog identities for ${key}`)
    bindings[key] = id
  }
  for (const entry of Object.values(classTrees.classes)) for (const node of entry.nodes) {
    const family = node.nodeType === 2 ? 'ability' : 'passive'
    const key = `${family}:${node.dataId}`
    const record = databases[family]?.find(record => record?.ID === node.dataId)
    if (!record || record.Name !== node.name) throw new Error(`Class-tree identity points to a missing or changed record: ${key}`)
    if (bindings[key] && bindings[key] !== node.entityId) throw new Error(`Class-tree identity conflicts with the numeric crosswalk: ${key}`)
    bindings[key] = node.entityId
  }
  return bindings
}

function clean(value) {
  if (Array.isArray(value)) return value.map(clean)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'Comments').map(([key, entry]) => [key, clean(entry)]))
  return value
}

function contentForDigest(snapshot) {
  const { contentDigest: _digest, catalogChecksum: _checksum, capturedAt: _date, ...content } = snapshot
  return canonicalJson(content)
}

function catalogDigest(snapshot) {
  const { checksum: _checksum, ...content } = buildNativeCatalog(snapshot)
  return hash(Buffer.from(canonicalJson(content)))
}

async function check() {
  const snapshot = JSON.parse(await readFile(OUTPUT, 'utf8'))
  validateNativeSnapshot(snapshot)
  if (hash(Buffer.from(contentForDigest(snapshot))) !== snapshot.contentDigest || catalogDigest(snapshot) !== snapshot.catalogChecksum) throw new Error('Native snapshot content or catalog checksum is stale')
  const identities = await readFile(IDENTITIES)
  const treeBytes = await readFile(CLASS_TREES)
  if (hash(identities) !== snapshot.identitySource.sha256) throw new Error('Native snapshot identity crosswalk has changed; regenerate the native data')
  if (hash(treeBytes) !== snapshot.identitySource.classTreesSha256) throw new Error('Native snapshot class-tree identities have changed; regenerate the native data')
  if (canonicalJson(identityBindingsFor(JSON.parse(identities), snapshot.databases, JSON.parse(treeBytes))) !== canonicalJson(snapshot.identityBindings)) throw new Error('Native snapshot bindings differ from the reviewed numeric crosswalk')
  const catalog = buildNativeCatalog(snapshot)
  console.log(`Verified Windows ${snapshot.source.gameVersion} native definitions, source fingerprints, executable version evidence, enum labels, and catalog checksum (${Object.keys(catalog.entities).length} records)`)
}

async function update(input, decompiler) {
  const content = resolve(input)
  const executablePath = join(content, '..', 'Crystal Project.exe')
  const executableBytes = await readFile(executablePath)
  const version = parseGameExecutableVersion(executableBytes)
  console.error(`Verified Crystal Project Windows ${version.gameVersion} from the executable version resource`)
  const databases = {}
  const files = []
  for (const family of [...Object.keys(NATIVE_FAMILIES), 'patch', 'system'].sort()) {
    const path = `Database/${family}.dat`
    const bytes = await readFile(join(content, path))
    if (bytes.length > MAX_SOURCE_BYTES) throw new Error(`${path} exceeds the source size limit`)
    const parsed = parseGameDatabase(bytes, family)
    databases[family] = family === 'system' ? clean(Object.fromEntries(['BattleConfig', 'FieldConfig', 'Vocab'].map(key => [key, parsed.records[key]]))) : clean(parsed.records)
    files.push({ path, sha256: hash(bytes), size: bytes.length, databaseVersion: parsed.version })
  }
  const enums = {}
  for (const type of NATIVE_ENUM_TYPES) {
    let output
    try { output = execFileSync(decompiler, ['-t', `${ENUM_NAMESPACE}${type}`, executablePath], { encoding: 'utf8', maxBuffer: MAX_SOURCE_BYTES, timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }) }
    catch (error) {
      if (error.code === 'ENOENT') { console.error('ILSpy CLI is required to refresh native enum labels; install ilspycmd or pass --decompiler'); process.exit(3) }
      throw new Error(`Unable to read executable enum ${type}; verify dotnet and ILSpy CLI`, { cause: error })
    }
    enums[type] = parseEnumSource(output, type)
  }
  const identityBytes = await readFile(IDENTITIES)
  const treeBytes = await readFile(CLASS_TREES)
  const identityManifest = JSON.parse(identityBytes)
  const identityBindings = identityBindingsFor(identityManifest, databases, JSON.parse(treeBytes))
  const snapshot = { schemaVersion: NATIVE_SNAPSHOT_SCHEMA, contentDigest: '0'.repeat(64), catalogChecksum: '0'.repeat(64), capturedAt: '', source: { platform: 'Windows', gameVersion: version.gameVersion, executable: { path: 'Crystal Project.exe', sha256: hash(executableBytes), size: executableBytes.length, ...version }, files }, databases, enums, identityBindings, identitySource: { sha256: hash(identityBytes), classTreesSha256: hash(treeBytes), commit: identityManifest.source.commit } }
  snapshot.contentDigest = hash(Buffer.from(contentForDigest(snapshot)))
  let previous
  try { previous = JSON.parse(await readFile(OUTPUT, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  snapshot.capturedAt = previous?.contentDigest === snapshot.contentDigest ? previous.capturedAt : new Date().toISOString()
  snapshot.catalogChecksum = catalogDigest(snapshot)
  const bytes = `${JSON.stringify(snapshot, null, 2).replace(/[\u2014\u2018\u2019\u201c\u201d]/g, char => `\\u${char.charCodeAt(0).toString(16)}`).replace(/@(?=(?:V\.Sep|X\.(?:ConvertMpToHpRatio|ConvertMpToApRatio|ConvertApToMpRatio|StrWhileUnarmedBonusFlat)))/g, '\\u0040')}\n`
  await writeFile(`${OUTPUT}.tmp`, bytes)
  await rename(`${OUTPUT}.tmp`, OUTPUT)
  console.log(`Saved Windows ${version.gameVersion} native gameplay definitions with numeric identities, mode overrides, enum labels, and source fingerprints`)
}

async function main() {
  let values
  try {
    values = parseArgs({ options: { input: { type: 'string', short: 'i' }, decompiler: { type: 'string', short: 'd' }, check: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } }, strict: true }).values
    if (values.help) { process.stdout.write(USAGE); return }
    if (values.check && (values.input !== undefined || values.decompiler !== undefined)) throw new Error('--check cannot be combined with --input or --decompiler')
    if (!values.check && !values.input?.trim()) throw new Error('--input is required when updating native data')
    if (values.decompiler !== undefined && !values.decompiler.trim()) throw new Error('--decompiler must not be empty')
  } catch (error) { console.error(error.message); process.exitCode = 2; return }
  try { if (values.check) await check(); else await update(values.input, values.decompiler ?? 'ilspycmd') }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
