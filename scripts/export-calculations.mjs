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
  values = parseArgs({ options: { output: { type: 'string', short: 'o' }, help: { type: 'boolean', short: 'h' } }, strict: true }).values
  if (values.help) { process.stdout.write(USAGE); process.exit(0) }
  if (values.output === '') throw new Error('Output filename must not be empty')
} catch (error) { console.error(error.message); process.exit(2) }

try {
  const read = async file => JSON.parse(await readFile(join(ROOT, file), 'utf8'))
  const [rules, data, legacy, verification] = await Promise.all(['src/calculations/pc-1.6.9-v1.json', 'src/catalog/native-stats-v1.json', 'src/calculations/guide-v1.json', 'src/calculations/pc-parity-v1.json'].map(read))
  if (rules.id !== data.engine || rules.source.executableSha256 !== data.executableSha256) throw new Error('Calculation rule and data identities differ')
  const json = `${JSON.stringify({ format: 'crystal-project-calculations', schemaVersion: 1, id: rules.id, rules, data, legacy, verification }, null, 2)}\n`
  if (values.output) await writeFile(values.output, json)
  else process.stdout.write(json)
} catch (error) { console.error(error.message); process.exitCode = 1 }
