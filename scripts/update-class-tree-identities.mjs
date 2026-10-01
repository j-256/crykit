#!/usr/bin/env node
import { readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { hash, parseGameDatabase, parseStarterRecords } from './game-assets.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OUTPUT = join(ROOT, 'src/catalog/class-tree-identities.json')
const DATABASE_NAMES = ['job', 'ability', 'passive']
const LP_DISPLAY = Object.freeze({ jpPerLp: 100, executableSha256: '36f7d413160a4deee36b47fc6ac534e87cadb6f23f57337d4630ec99cedb14e6', locator: 'WindowLearnAbilitySelect.Draw; JP / 100', version: 'PC 1.6.9.0' })
const USAGE = `Usage: node scripts/update-class-tree-identities.mjs -i|--input <Content>
       node scripts/update-class-tree-identities.mjs --check
Build the class-tree name and LP-cost supplement from installed game databases.
Every tree must match the committed vanilla class-copy export exactly, and each
skill must have one exact name and class match in the bundled reference sources.
LP conversion requires the reviewed PC 1.6.9.0 executable beside Content.
The output retains source hashes and native IDs without private input paths.
  -i, --input <Content>  Installed game's Content directory
      --check            Verify the committed supplement offline without writes
  -h, --help             Show help
Results go to stdout; errors go to stderr.
Exit: 0 success/help, 1 integrity or runtime failure, 2 invalid options.
`

function options() {
  try {
    const { values } = parseArgs({ options: { input: { type: 'string', short: 'i' }, check: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } }, strict: true })
    if (values.help) { process.stdout.write(USAGE); process.exit(0) }
    if (Boolean(values.check) === Boolean(values.input) || values.input === '') throw new Error('Choose --input <Content> or --check')
    return values
  } catch (error) { console.error(error.message); process.exit(2) }
}

async function references() {
  const [baselineBytes, starterText, wikiText] = await Promise.all([
    readFile(join(ROOT, 'src/catalog/vanilla-jobs.json')),
    readFile(join(ROOT, 'src/catalog/data.ts'), 'utf8'),
    readFile(join(ROOT, 'src/catalog/wiki-data.json'), 'utf8'),
  ])
  return { baseline: JSON.parse(baselineBytes), baselineSha256: hash(baselineBytes), starter: parseStarterRecords(starterText), wiki: JSON.parse(wikiText).entities }
}

function referenceId(refs, job, skill, kind) {
  const prefix = `base:${job.Name.toLowerCase()}:`
  const scoped = refs.starter.filter(record => record.name === skill.Name && record.kind === kind && record.id.startsWith(prefix))
  const candidates = scoped.length ? scoped : refs.wiki.filter(record => record.name === skill.Name && record.kind === kind && record.fields.Class?.state === 'known' && record.fields.Class.value === job.Name)
  if (candidates.length !== 1) throw new Error(`Expected one class-scoped reference for ${job.Name} > ${skill.Name} (${kind})`)
  return candidates[0].id
}

async function build(input, refs) {
  if (hash(await readFile(join(input, '..', 'Crystal Project.exe'))) !== LP_DISPLAY.executableSha256) throw new Error('Learning-cost display needs review for this game executable')
  const databases = {}
  const databaseSha256 = {}
  for (const name of DATABASE_NAMES) {
    const bytes = await readFile(join(input, 'Database', `${name}.dat`))
    databases[name] = parseGameDatabase(bytes, name).records
    databaseSha256[name] = hash(bytes)
  }
  const classes = {}
  for (const job of refs.baseline.jobs) {
    const matches = databases.job.filter(record => record?.Name === job.Name)
    if (matches.length !== 1 || JSON.stringify(matches[0].LearnTree) !== JSON.stringify(job.LearnTree)) throw new Error(`Native tree differs from the reviewed class-copy baseline: ${job.Name}`)
    const nodes = job.LearnTree.flatMap((column, x) => column.flatMap((node, y) => {
      if (node.NodeType !== 2 && node.NodeType !== 3) return []
      const family = node.NodeType === 2 ? 'ability' : 'passive'
      const skill = databases[family].find(record => record?.ID === node.DataID)
      if (!skill || !Number.isInteger(skill.JP) || skill.JP < 0) throw new Error(`Missing native skill or learning cost: ${job.Name} > ${family} ${node.DataID}`)
      const kind = family === 'passive' ? skill.IsInnate ? 'innate' : 'passive' : skill.IsSightLearned ? 'monsterMagic' : 'ability'
      return [{ row: y, column: x, nodeType: node.NodeType, dataId: node.DataID, name: skill.Name, kind, jp: skill.JP, entityId: referenceId(refs, job, skill, kind) }]
    })).sort((a, b) => a.row - b.row || a.column - b.column)
    classes[`base:class:${job.Name.toLowerCase()}`] = { nativeJobId: matches[0].ID, copiedJobId: job.ID, nodes }
  }
  return { schemaVersion: 1, source: { sourceId: 'crystal-project:pc-class-tree-identities', snapshot: LP_DISPLAY.version, applicability: 'Supplement for exact matching vanilla class-copy trees; Nintendo Switch and mod parity are unverified' }, learningCostDisplay: LP_DISPLAY, baselineSha256: refs.baselineSha256, databaseSha256, classes }
}

function check(manifest, refs) {
  if (manifest.schemaVersion !== 1 || manifest.baselineSha256 !== refs.baselineSha256 || DATABASE_NAMES.some(name => !/^[a-f0-9]{64}$/.test(manifest.databaseSha256?.[name] ?? ''))) throw new Error('Class-tree supplement has stale or invalid source pins')
  if (JSON.stringify(manifest.learningCostDisplay) !== JSON.stringify(LP_DISPLAY)) throw new Error('Class-tree learning-cost display evidence is invalid')
  if (Object.keys(manifest.classes ?? {}).length !== refs.baseline.jobs.length) throw new Error('Class-tree supplement coverage is incomplete')
  for (const job of refs.baseline.jobs) {
    const entry = manifest.classes[`base:class:${job.Name.toLowerCase()}`]
    const expected = job.LearnTree.flatMap((column, x) => column.flatMap((node, y) => node.NodeType === 2 || node.NodeType === 3 ? [{ row: y, column: x, nodeType: node.NodeType, dataId: node.DataID }] : [])).sort((a, b) => a.row - b.row || a.column - b.column)
    if (entry?.copiedJobId !== job.ID || !Number.isInteger(entry.nativeJobId) || !Array.isArray(entry.nodes) || entry.nodes.length !== expected.length) throw new Error(`Invalid tree identity coverage: ${job.Name}`)
    for (const [index, node] of entry.nodes.entries()) {
      const position = expected[index]
      if (Object.entries(position).some(([key, value]) => node[key] !== value) || !Number.isInteger(node.jp) || node.jp < 0 || !['ability', 'monsterMagic', 'passive', 'innate'].includes(node.kind) || node.entityId !== referenceId(refs, job, { Name: node.name }, node.kind)) throw new Error(`Invalid skill identity: ${job.Name} > row ${position.row}, column ${position.column}`)
    }
  }
}

try {
  const values = options()
  const refs = await references()
  if (values.check) {
    check(JSON.parse(await readFile(OUTPUT, 'utf8')), refs)
    console.log('Verified bundled class-tree identities and source pins')
  } else {
    const manifest = await build(values.input, refs)
    check(manifest, refs)
    const temporary = `${OUTPUT}.tmp`
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`)
    await rename(temporary, OUTPUT)
    console.log('Updated bundled class-tree identities')
  }
} catch (error) { console.error(error.message); process.exitCode = 1 }
