#!/usr/bin/env node
import { readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { GAME_IDENTITY_MANIFEST_SCHEMA, buildGameIdentityCrosswalk, hash, parseArchipelagoItems, parsePythonStringAssignments, parseStarterRecords, stableSourceDigest } from './game-assets.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const MANIFEST = join(ROOT, 'src', 'catalog', 'game-identities.json')
const STARTER_SOURCE = join(ROOT, 'src', 'catalog', 'data.ts')
const REPOSITORY = 'Emerassi/CrystalProjectAPWorld'
const ITEMS_FILE = 'worlds/crystal_project/items.py'
const CONSTANT_FILES = [
  'worlds/crystal_project/constants/crystal_locations.py',
  'worlds/crystal_project/constants/display_regions.py',
  'worlds/crystal_project/constants/item_groups.py',
  'worlds/crystal_project/constants/jobs.py',
  'worlds/crystal_project/constants/key_items.py',
  'worlds/crystal_project/constants/keys.py',
  'worlds/crystal_project/constants/maps.py',
  'worlds/crystal_project/constants/mounts.py',
  'worlds/crystal_project/constants/region_passes.py',
  'worlds/crystal_project/constants/scholar_abilities.py',
  'worlds/crystal_project/constants/summons.py',
  'worlds/crystal_project/constants/teleport_stones.py',
]
const SOURCE_FILES = [ITEMS_FILE, ...CONSTANT_FILES]
const REQUEST_TIMEOUT_MS = 30_000
const USAGE = `Usage: node scripts/update-game-identities.mjs --ref <commit> [-h|--help]
       node scripts/update-game-identities.mjs --check [-h|--help]
Build the explicit starter-catalog to native-game database crosswalk from a pinned
Crystal Project Archipelago commit. The updater downloads only public Python source
text and writes src/catalog/game-identities.json atomically. It never reads game
files, personal data, credentials, or local planner records.
  -r, --ref <commit>  Full 40-character Archipelago Git commit to import
      --check         Validate the committed crosswalk offline without writes
  -h, --help          Show this help
Results go to stdout; progress and errors go to stderr.
Exit: 0 success/help, 1 runtime or integrity failure, 2 invalid options.
`

function options() {
  try {
    const { values } = parseArgs({ options: { help: { type: 'boolean', short: 'h' }, ref: { type: 'string', short: 'r' }, check: { type: 'boolean' } }, strict: true })
    if (values.help) { process.stdout.write(USAGE); process.exit(0) }
    if (values.check && values.ref) throw new Error('--check and --ref are mutually exclusive')
    if (!values.check && !values.ref) throw new Error('--ref is required when updating the crosswalk')
    if (values.ref && !/^[a-f0-9]{40}$/.test(values.ref)) throw new Error('--ref must be a full lowercase 40-character Git commit')
    return values
  } catch (error) { console.error(error.message); process.exit(2) }
}

function rawUrl(ref, path) {
  return `https://raw.githubusercontent.com/${REPOSITORY}/${ref}/${path}`
}

function sourceUrl(ref, path, line) {
  return `https://github.com/${REPOSITORY}/blob/${ref}/${path}${line ? `#L${line}` : ''}`
}

async function fetchSource(ref, path) {
  const response = await fetch(rawUrl(ref, path), { redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`${path}: source download returned HTTP ${response.status}`)
  const content = await response.text()
  if (!content) throw new Error(`${path}: source download is empty`)
  return [path, content]
}

function validateCoverage(manifest, starterRecords) {
  if (manifest.schemaVersion !== GAME_IDENTITY_MANIFEST_SCHEMA) throw new Error('Game identity manifest schema is stale')
  if (!/^[a-f0-9]{40}$/.test(manifest.source?.commit ?? '') || !/^[a-f0-9]{64}$/.test(manifest.source?.contentDigest ?? '')) throw new Error('Game identity source pin is invalid')
  const starterById = new Map(starterRecords.map(record => [record.id, record]))
  const covered = new Set()
  for (const [id, mapping] of Object.entries(manifest.mappings ?? {})) {
    const record = starterById.get(id)
    if (!record || record.kind !== mapping.kind || record.name !== mapping.name || record.sourceKey !== mapping.sourceKey) throw new Error(`Game identity mapping does not match the starter catalog: ${id}`)
    if (!['job', 'item', 'equipment', 'ability'].includes(mapping.database) || !Number.isInteger(mapping.databaseId) || mapping.databaseId < 0 || !Number.isInteger(mapping.upstreamCode) || !mapping.upstreamName || !mapping.locator || mapping.sourceUrl !== sourceUrl(manifest.source.commit, ITEMS_FILE, Number(mapping.locator.split(':').at(-1)))) throw new Error(`Game identity mapping is invalid: ${id}`)
    covered.add(id)
  }
  for (const gap of manifest.unresolved ?? []) {
    const record = starterById.get(gap.id)
    if (!record || record.kind !== gap.kind || record.name !== gap.name || record.sourceKey !== gap.sourceKey || !gap.reason || covered.has(gap.id)) throw new Error(`Game identity gap is invalid: ${gap.id}`)
    covered.add(gap.id)
  }
  if (covered.size !== starterRecords.length) throw new Error('Game identity manifest does not cover every starter identity')
  if (!Array.isArray(manifest.source.files) || !manifest.source.files.length || manifest.source.files.some(file => !SOURCE_FILES.includes(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256) || file.url !== sourceUrl(manifest.source.commit, file.path))) throw new Error('Game identity source file inventory is invalid')
}

async function check() {
  const starterRecords = parseStarterRecords(await readFile(STARTER_SOURCE, 'utf8'))
  const bytes = await readFile(MANIFEST)
  const manifest = JSON.parse(bytes)
  validateCoverage(manifest, starterRecords)
  console.log(`Verified ${Object.keys(manifest.mappings).length} native identity mappings and ${manifest.unresolved.length} explicit gaps (${hash(bytes)} manifest SHA-256)`)
}

async function update(ref) {
  console.error(`Fetching pinned Archipelago identity sources at ${ref}`)
  const sources = await Promise.all(SOURCE_FILES.map(path => fetchSource(ref, path)))
  const sourceMap = new Map(sources)
  const constants = new Map()
  for (const path of CONSTANT_FILES) {
    for (const [name, value] of parsePythonStringAssignments(sourceMap.get(path), path)) {
      if (constants.has(name) && constants.get(name) !== value) throw new Error(`Archipelago constants disagree for ${name}`)
      constants.set(name, value)
    }
  }
  const items = parseArchipelagoItems(sourceMap.get(ITEMS_FILE), constants)
  const starterRecords = parseStarterRecords(await readFile(STARTER_SOURCE, 'utf8'))
  const crosswalk = buildGameIdentityCrosswalk(starterRecords, items)
  const manifest = {
    schemaVersion: GAME_IDENTITY_MANIFEST_SCHEMA,
    source: {
      repository: `https://github.com/${REPOSITORY}`,
      commit: ref,
      contentDigest: stableSourceDigest(sources),
      rights: 'MIT-licensed source; factual database identifiers and labels retained with provenance',
      files: sources.map(([path, content]) => ({ path, url: sourceUrl(ref, path), sha256: hash(Buffer.from(content)) })),
    },
    mappings: Object.fromEntries(Object.entries(crosswalk.mappings).map(([id, mapping]) => [id, { ...mapping, sourceUrl: sourceUrl(ref, ITEMS_FILE, Number(mapping.locator.split(':').at(-1))) }])),
    unresolved: crosswalk.unresolved,
  }
  validateCoverage(manifest, starterRecords)
  const temporary = `${MANIFEST}.tmp`
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`)
  await rename(temporary, MANIFEST)
  console.log(`Saved ${Object.keys(manifest.mappings).length} native identity mappings and ${manifest.unresolved.length} explicit gaps from pinned Archipelago sources`)
}

try {
  const flags = options()
  if (flags.check) await check()
  else await update(flags.ref)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
