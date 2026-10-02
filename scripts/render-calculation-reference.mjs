#!/usr/bin/env node
import { readFile, writeFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { buildCalculationReference } from './lib/calculation-reference.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OUTPUT = join(ROOT, 'docs/calculation-reference.md')
const USAGE = `Usage: node scripts/render-calculation-reference.mjs [--check]
Render the human-readable equivalent of the bundled calculation package.
      --check  Reject documentation drift without writing files
  -h, --help   Show help
Requires Node.js. No game installation or network requests.
Results go to stdout; errors go to stderr. Exit: 0 success, 1 runtime/drift,
2 invalid options.
`
let values
try {
  values = parseArgs({
    options: { check: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    strict: true,
  }).values
  if (values.help) {
    process.stdout.write(USAGE)
    process.exit(0)
  }
} catch (error) {
  console.error(error.message)
  process.exit(2)
}
try {
  const read = async (path) => JSON.parse(await readFile(join(ROOT, path), 'utf8'))
  const [rules, combat, combatData, example] = await Promise.all(
    [
      'src/calculations/pc-1.6.9-v1.json',
      'src/calculations/combat-v1.json',
      'src/catalog/native-combat-v1.json',
      'src/calculations/combat-example-v1.json',
    ].map(read),
  )
  const markdown = buildCalculationReference({ rules, combat, combatData, example })
  if (values.check) {
    if ((await readFile(OUTPUT, 'utf8')) !== markdown)
      throw new Error('Human calculation reference differs from its machine rules; regenerate it')
  } else {
    await writeFile(`${OUTPUT}.tmp`, markdown)
    await rename(`${OUTPUT}.tmp`, OUTPUT)
  }
  console.log(
    values.check
      ? 'Verified human calculation reference against machine rules'
      : 'Generated human calculation reference',
  )
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
