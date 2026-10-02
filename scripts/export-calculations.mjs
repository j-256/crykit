#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const USAGE = `Usage: node scripts/export-calculations.mjs [-o <file>] [--schema-version <1|2>]
Export bundled Crystal Project calculation rules and numeric records as JSON.
  -o, --output <file>  Write a file instead of stdout
      --schema-version <1|2>  Export format 2 (default) or the unchanged legacy format 1
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
      'schema-version': { type: 'string', default: '2' },
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
  if (!['1', '2'].includes(values['schema-version']))
    throw new Error('Schema version must be 1 or 2')
} catch (error) {
  console.error(error.message)
  process.exit(2)
}

try {
  const read = async (file) => JSON.parse(await readFile(join(ROOT, file), 'utf8'))
  const [rules, data, legacy, verification] = await Promise.all(
    [
      'src/calculations/pc-1.6.9-v1.json',
      'src/catalog/native-stats-v1.json',
      'src/calculations/guide-v1.json',
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
    legacy,
    verification,
  }
  if (values['schema-version'] === '2') {
    const [combat, combatData, combatVerification, example, enemy] = await Promise.all(
      [
        'src/calculations/combat-v1.json',
        'src/catalog/native-combat-v1.json',
        'src/calculations/combat-parity-v1.json',
        'src/calculations/combat-example-v1.json',
        'src/calculations/enemy-difficulty-v1.json',
      ].map(read),
    )
    if (
      combat.id !== combatData.engine ||
      combat.id !== combatVerification.engine ||
      combat.source.executableSha256 !== data.executableSha256 ||
      combatData.nativeDataDigest !== data.nativeDataDigest ||
      enemy.source.executableSha256 !== data.executableSha256
    )
      throw new Error('Combat calculation identities differ')
    exported = {
      ...exported,
      schemaVersion: 2,
      id: 'pc-1.6.9-package-v2',
      combat,
      combatData,
      combatVerification,
      example,
      enemy,
    }
  }
  const json = `${JSON.stringify(exported, null, 2)}\n`
  if (values.output) await writeFile(values.output, json)
  else process.stdout.write(json)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
