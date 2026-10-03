#!/usr/bin/env node
import { readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { extractEntityReference, contentDigest } from './update-entity-reference.mjs'
import { parseGameDatabase } from './game-assets.mjs'
import { projectWorldAcquisition } from './lib/world-acquisition.mjs'
import { validateWorldAcquisition } from '../src/domain/item-acquisition.ts'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OUTPUT = join(ROOT, 'src/catalog/world-acquisition-v1.json')
const SCOPE = 'Item acquisition facts from field world and starting inventory'
const USAGE = `Usage: node --experimental-strip-types scripts/update-world-acquisition.mjs -i|--input <installation-or-Content>
       node --experimental-strip-types scripts/update-world-acquisition.mjs --check
Generate factual item acquisition routes from a fingerprinted owned Windows game.
  -i, --input <path>  Installation containing Crystal Project.exe, or its Content
      --check         Validate committed routes, digest and source pins offline
  -h, --help          Show help
Update requires Node >=22.12 and .NET SDK 10. Check requires Node only.
Game, editor, world and system hashes must match the reviewed bundled sources.
The reviewed decoder runs on a temporary architecture-adapted assembly copy.
No installation files change. No network requests or environment variables needed.
Only normalized acquisition facts are saved, without dialogue or raw scripts.
Results go to stdout; diagnostics go to stderr.
Exit: 0 success/help, 1 integrity/read failure, 2 invalid options, 3 missing SDK.
`

export function validateAcquisitionSource(snapshot, native, reference) {
  validateWorldAcquisition(snapshot)
  if (snapshot.contentDigest !== contentDigest(snapshot)) throw new Error('Acquisition content digest differs')
  const source = snapshot.source
  if (source.scope !== SCOPE || source.rights !== reference.source.rights || source.nativeContentDigest !== native.contentDigest || source.platform !== native.source.platform || source.gameVersion !== native.source.gameVersion || source.gameExecutableSha256 !== native.source.executable.sha256 || source.editorExecutableSha256 !== reference.source.editorExecutableSha256 || source.systemSha256 !== native.source.files.find(file => file.path === 'Database/system.dat')?.sha256) throw new Error('Acquisition source fingerprints differ')
  for (const key of ['world', 'biomes']) for (const field of ['path', 'sha256', 'size']) if (source[key][field] !== reference.source[key][field]) throw new Error(`Acquisition ${key} source differs`)
  if (!source.evidence.length || source.evidence.some(entry => !entry || entry.startsWith('/') || entry.includes('\\'))) throw new Error('Acquisition evidence must be portable')
  const definitions = new Map(['item', 'equipment', 'recipe', 'biome'].map(family => [family, new Set(native.databases[family].filter(Boolean).map(record => record.ID))]))
  const entities = new Map(reference.records.map(entity => [entity.ID, entity]))
  for (const entry of snapshot.entries) {
    if (!definitions.get(entry.family).has(entry.targetID) || entry.biomeID !== undefined && !definitions.get('biome').has(entry.biomeID) || (entry.costs ?? []).some(cost => !definitions.get(cost.family).has(cost.id))) throw new Error('Acquisition definition identity is unresolved')
    if (entry.entityID !== undefined) {
      const entity = entities.get(entry.entityID)
      if (!entity || entity.BiomeID !== entry.biomeID || ['X', 'Y', 'Z'].some(axis => entity.Coord[axis] !== entry.coord?.[axis])) throw new Error('Acquisition world location differs')
    }
  }
}

async function main() {
  let values
  try {
    values = parseArgs({ options: { input: { type: 'string', short: 'i' }, check: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } }, strict: true }).values
    if (values.help) { process.stdout.write(USAGE); return }
    if (values.check && values.input !== undefined) throw new Error('--check cannot be combined with --input')
    if (!values.check && !values.input?.trim()) throw new Error('--input is required when updating acquisition sources')
  } catch (error) { console.error(error.message); process.exitCode = 2; return }
  try {
    const native = JSON.parse(await readFile(join(ROOT, 'src/catalog/native-game-data.json'), 'utf8'))
    const reference = JSON.parse(await readFile(join(ROOT, 'src/mod-inspector/entity-reference.json'), 'utf8'))
    if (values.check) {
      const snapshot = JSON.parse(await readFile(OUTPUT, 'utf8'))
      validateAcquisitionSource(snapshot, native, reference)
      console.log('Verified acquisition routes, exact source pins and content digest')
      return
    }
    const { source, records } = await extractEntityReference(values.input, true)
    const installation = basename(resolve(values.input)).toLowerCase() === 'content' ? dirname(resolve(values.input)) : resolve(values.input)
    const systemBytes = await readFile(join(installation, 'Content/Database/system.dat'))
    const { createHash } = await import('node:crypto')
    const systemSha256 = createHash('sha256').update(systemBytes).digest('hex')
    if (native.source.files.find(file => file.path === 'Database/system.dat')?.sha256 !== systemSha256) throw new Error('System data fingerprint differs')
    const snapshot = { schemaVersion: 1, contentDigest: '', source: { ...source, scope: SCOPE, nativeContentDigest: native.contentDigest, systemSha256, evidence: [...source.evidence, 'Sang.Field.Entity.EntityNpc.RefreshCurrentOutfit/RefreshCurrentPage', 'Sang.Field.EntityAction.EntityAction.InterpretNpcActionStep', 'Sang.Window.Field.Shop.MenuItemBuyItem.Set/RoundCost', 'Sang.Window.Field.Shop.MenuItemRecipeItem.Set', 'Sang.Field.ConditionEvaluator.EvaluateCondition', 'Sang.PartyData.Party.SetupNewGame'] }, entries: projectWorldAcquisition(records, parseGameDatabase(systemBytes, 'system').records) }
    snapshot.contentDigest = contentDigest(snapshot)
    validateAcquisitionSource(snapshot, native, reference)
    const output = `${JSON.stringify(snapshot, null, 2).replace(/[\u2014\u2018\u2019\u201c\u201d]/g, char => `\\u${char.charCodeAt(0).toString(16)}`)}\n`
    await writeFile(`${OUTPUT}.tmp`, output)
    await rename(`${OUTPUT}.tmp`, OUTPUT)
    console.log('Saved fingerprinted world acquisition facts')
  } catch (error) { console.error(error.message); process.exitCode = error.exitCode ?? 1 }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
