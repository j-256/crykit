#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const USAGE = `Usage: node scripts/export-calculations.mjs [-o <file>] [--schema-version <1|2|3>]
Export bundled Crystal Project calculation rules and numeric records as JSON.
  -o, --output <file>  Write a file instead of stdout
      --schema-version <1|2|3>  Export format 3 (default), or unchanged historical formats 1 or 2
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
      'schema-version': { type: 'string', default: '3' },
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
  if (!['1', '2', '3'].includes(values['schema-version']))
    throw new Error('Schema version must be 1, 2 or 3')
} catch (error) {
  console.error(error.message)
  process.exit(2)
}

try {
  const read = async (file) => JSON.parse(await readFile(join(ROOT, file), 'utf8'))
  const [rules, data, verification] = await Promise.all(
    [
      'src/calculations/pc-1.6.9-v1.json',
      'src/catalog/native-stats-v1.json',
      'src/calculations/pc-parity-v1.json',
    ].map(read),
  )
  if (rules.id !== data.engine || rules.source.executableSha256 !== data.executableSha256)
    throw new Error('Calculation rule and data identities differ')
  let exported = {
    format: 'crystal-project-calculations',
    schemaVersion: 1,
    id: rules.id,
    rules,
    data,
  }
  if (values['schema-version'] === '1') {
    exported = { ...exported, legacy: await read('src/calculations/guide-v1.json'), verification }
  } else {
    const [combat, combatData, combatVerification, previewVerification, example, enemy] = await Promise.all(
      [
        'src/calculations/combat-v1.json',
        'src/catalog/native-combat-v1.json',
        'src/calculations/combat-parity-v1.json',
        'src/calculations/preview-parity-v1.json',
        'src/calculations/combat-example-v1.json',
        'src/calculations/enemy-difficulty-v1.json',
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
    exported = {
      ...exported,
      schemaVersion: 2,
      id: 'pc-1.6.9-package-v2',
      verification,
      combat,
      combatData,
      combatVerification,
      previewVerification,
      example,
      enemy,
    }
  }
  if (values['schema-version'] === '3') {
    const modifiers = await read('src/calculations/native-modifiers-v1.json')
    const modifierVerification = await read('src/calculations/modifier-parity-v1.json')
    if (modifiers.engine !== rules.id || modifierVerification.engine !== rules.id || modifiers.executableSha256 !== data.executableSha256 || modifierVerification.evidence.executableSha256 !== data.executableSha256 || Object.entries(modifiers.sourceFiles).some(([file, digest]) => modifierVerification.evidence.files[file] !== digest)) throw new Error('Modifier calculation identities differ')
    exported = { ...exported, schemaVersion: 3, id: 'pc-1.6.9-package-v3', modifiers, modifierVerification }
  }
  const json = `${JSON.stringify(exported, null, 2)}\n`
  if (values.output) await writeFile(values.output, json)
  else process.stdout.write(json)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
