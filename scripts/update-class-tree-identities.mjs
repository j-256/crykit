#!/usr/bin/env node
import { readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { hash } from './game-assets.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OUTPUT = join(ROOT, 'src/catalog/class-tree-identities.json')
const NATIVE = join(ROOT, 'src/catalog/native-game-data.json')
const DATABASE_NAMES = ['job', 'ability', 'passive']
const LP_DISPLAY = Object.freeze({ jpPerLp: 100, executableSha256: '36f7d413160a4deee36b47fc6ac534e87cadb6f23f57337d4630ec99cedb14e6', locator: 'WindowLearnAbilitySelect.Draw; JP / 100', version: 'PC 1.6.9.0' })
const USAGE = `Usage: node scripts/update-class-tree-identities.mjs [-i|--input <Content>]
       node scripts/update-class-tree-identities.mjs --check
Project class-tree positions, numeric skill identities, and LP costs from the
bundled native snapshot. Optional input verifies original game file fingerprints.
LP conversion requires the reviewed PC 1.6.9.0 executable beside Content.
Requires Node.js and committed native gameplay data; no environment variables.
  -i, --input <Content>  Verify the owned game's Content directory while projecting
      --check            Verify the committed projection offline without writes
  -h, --help             Show help
Results go to stdout; errors go to stderr.
Exit: 0 success/help, 1 integrity or runtime failure, 2 invalid options.
`

export function buildClassTreeIdentities(snapshot) {
  if (snapshot.source.executable.sha256 !== LP_DISPLAY.executableSha256) throw new Error('Learning-cost display needs review for this game executable')
  const databaseSha256 = Object.fromEntries(DATABASE_NAMES.map(name => {
    const sha256 = snapshot.source.files.find(file => file.path === `Database/${name}.dat`)?.sha256
    if (!/^[a-f0-9]{64}$/.test(sha256 ?? '')) throw new Error(`Missing native ${name} fingerprint`)
    return [name, sha256]
  }))
  const classes = {}
  for (const job of snapshot.databases.job.filter(Boolean)) {
    const entityId = snapshot.identityBindings[`job:${job.ID}`]
    if (!entityId || classes[entityId]) throw new Error(`Missing or duplicated native class identity: ${job.ID}`)
    const nodes = job.LearnTree.flatMap((column, x) => column.flatMap((node, y) => {
      if (node.NodeType !== 2 && node.NodeType !== 3) return []
      const family = node.NodeType === 2 ? 'ability' : 'passive'
      const skill = snapshot.databases[family].find(record => record?.ID === node.DataID)
      const skillId = snapshot.identityBindings[`${family}:${node.DataID}`]
      if (!skill || !Number.isInteger(skill.JP) || skill.JP < 0 || !skillId) throw new Error(`Missing native skill, identity, or learning cost: ${job.ID} > ${family} ${node.DataID}`)
      const kind = family === 'passive' ? skill.IsInnate ? 'innate' : 'passive' : skill.IsSightLearned ? 'monsterMagic' : 'ability'
      return [{ row: y, column: x, nodeType: node.NodeType, dataId: node.DataID, name: skill.Name, kind, jp: skill.JP, entityId: skillId }]
    })).sort((a, b) => a.row - b.row || a.column - b.column)
    classes[entityId] = { nativeJobId: job.ID, nodes }
  }
  return { schemaVersion: 1, source: { sourceId: 'crystal-project:pc-class-tree-identities', snapshot: LP_DISPLAY.version, applicability: 'Native class learning trees for PC 1.6.9.0; other versions and mod configurations require separate evidence' }, learningCostDisplay: LP_DISPLAY, databaseSha256, classes }
}

async function main() {
  let values
  try {
    values = parseArgs({ options: { input: { type: 'string', short: 'i' }, check: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } }, strict: true }).values
    if (values.help) { process.stdout.write(USAGE); return }
    if (values.check && values.input !== undefined || values.input !== undefined && !values.input.trim()) throw new Error('Use --check separately or a nonempty --input directory')
  } catch (error) { console.error(error.message); process.exitCode = 2; return }
  const snapshot = JSON.parse(await readFile(NATIVE, 'utf8'))
  const manifest = buildClassTreeIdentities(snapshot)
  if (values.input) {
    if (hash(await readFile(join(values.input, '..', 'Crystal Project.exe'))) !== LP_DISPLAY.executableSha256) throw new Error('Installed executable differs from the reviewed learning-cost evidence')
    for (const name of DATABASE_NAMES) if (hash(await readFile(join(values.input, 'Database', `${name}.dat`))) !== manifest.databaseSha256[name]) throw new Error(`Installed ${name} database differs from the bundled snapshot`)
  }
  if (values.check) {
    if (JSON.stringify(JSON.parse(await readFile(OUTPUT, 'utf8'))) !== JSON.stringify(manifest)) throw new Error('Class-tree identities differ from the native snapshot; regenerate them')
    console.log('Verified bundled native class-tree identities and source pins')
  } else {
    await writeFile(`${OUTPUT}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`)
    await rename(`${OUTPUT}.tmp`, OUTPUT)
    console.log('Updated bundled native class-tree identities')
  }
}

if (process.argv[1] && await realpath(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1 })
