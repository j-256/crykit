#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const USAGE = `Usage: node scripts/export-calculations.mjs [-o <file>]
Export bundled Crystal Project calculation rules and numeric records as JSON.
  -o, --output <file>  Write a file instead of stdout
  -h, --help           Show help
No game installation, saves, private data, or network access are needed.
JSON goes to stdout by default; errors go to stderr. Exit: 0 success,
1 file/integrity failure, 2 invalid options. Requires Node.js.
`
let values
try {
  values = parseArgs({
    options: {
      output: { type: 'string', short: 'o' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  }).values
  if (values.help) {
    process.stdout.write(USAGE)
    process.exit(0)
  }
  if (values.output !== undefined && !values.output.trim())
    throw new Error('Output filename must not be empty')
} catch (error) {
  console.error(error.message)
  process.exit(2)
}

try {
  const read = async (file) => JSON.parse(await readFile(join(ROOT, file), 'utf8'))
  const [rules, data, verification] = await Promise.all(
    [
      'src/calculations/character-rules-v1.json',
      'src/catalog/native-stats-v1.json',
      'src/calculations/pc-parity-v1.json',
    ].map(read),
  )
  if (rules.id !== data.engine || rules.source.executableSha256 !== data.executableSha256)
    throw new Error('Calculation rule and data identities differ')
  const [combat, combatData, combatVerification, previewVerification, example, enemy, modifiers, modifierVerification] = await Promise.all(
    [
      'src/calculations/combat-v1.json',
      'src/catalog/native-combat-v1.json',
      'src/calculations/combat-parity-v1.json',
      'src/calculations/preview-parity-v1.json',
      'src/calculations/combat-example-v1.json',
      'src/calculations/enemy-difficulty-v1.json',
      'src/calculations/native-modifiers-v1.json',
      'src/calculations/modifier-parity-v1.json',
    ].map(read),
  )
  if (
    combat.id !== combatData.engine ||
    combat.id !== combatVerification.engine ||
    combat.source.executableSha256 !== data.executableSha256 ||
    combatData.nativeDataDigest !== data.nativeDataDigest ||
    previewVerification.evidence.executableSha256 !== data.executableSha256 ||
    previewVerification.evidence.files.some(
      ({ file, sha256 }) => combat.source.files[file] !== sha256,
    ) ||
    enemy.source.executableSha256 !== data.executableSha256
  )
    throw new Error('Combat calculation identities differ')
  if (modifiers.engine !== rules.id || modifierVerification.engine !== rules.id || modifiers.executableSha256 !== data.executableSha256 || modifierVerification.evidence.executableSha256 !== data.executableSha256 || Object.entries(modifiers.sourceFiles).some(([file, digest]) => modifierVerification.evidence.files[file] !== digest)) throw new Error('Modifier calculation identities differ')
  const exported = {
    format: 'crystal-project-calculations',
    schemaVersion: 1,
    id: 'crystal-project-calculations-v1',
    rules,
    data,
    verification,
    combat,
    combatData,
    combatVerification,
    previewVerification,
    example,
    enemy,
    modifiers,
    modifierVerification,
  }
  const json = `${JSON.stringify(exported, null, 2)}\n`
  if (values.output) await writeFile(values.output, json)
  else process.stdout.write(json)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
