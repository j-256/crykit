#!/usr/bin/env node
import { readFile, writeFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createHash } from 'node:crypto'
import { buildCombatRules } from './lib/combat-rules.mjs'
import { buildCalculationSchema } from './lib/calculation-schema.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const USAGE = `Usage: node scripts/update-combat-calculations.mjs [--check]
Generate the versioned combat rules and numeric combat data offline.
      --check  Reject drift without writing files
  -h, --help   Show help
Requires Node.js. No game installation, saves, or network access are needed.
Results go to stdout; errors go to stderr. Exit: 0 success, 1 integrity/runtime,
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

const numeric = (value) => {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map(numeric)
  if (typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => typeof entry !== 'string')
        .map(([key, entry]) => [key, numeric(entry)]),
    )
  throw new Error('Non-numeric combat data')
}
const FIELDS = {
  monster: [
    'ID',
    'IsPvp',
    'PvpJobID',
    'PvpGenderID',
    'PvpWeaponID',
    'Level',
    'IsBoss',
    'Exp',
    'JP',
    'Money',
    'ItemDrops',
    'ItemSteals',
    'HP',
    'MP',
    'Str',
    'Vit',
    'Dex',
    'Agi',
    'Mnd',
    'Spi',
    'Spd',
    'Lck',
    'PAtk',
    'PPen',
    'PDef',
    'PCritChance',
    'PCritDmg',
    'PAccRating',
    'PEvaRating',
    'MPen',
    'MDef',
    'PVariance',
    'StatMods',
  ],
  status: [
    'ID',
    'Category',
    'ReApplyResistance',
    'PersistsThroughDeath',
    'PreventRemoval',
    'StatMods',
    'DecrementOnFixedInterval',
    'DecrementOnEachUserTurn',
    'DecrementOnDmgTaken',
    'DecrementOnPDmgTaken',
    'DecrementOnPDmgEvaded',
    'DecrementOnPDmgGiven',
    'DecrementOnMDmgTaken',
    'DecrementOnMDmgEvaded',
    'DecrementOnMDmgGiven',
    'DecrementOnHealTaken',
    'DecrementOnHealGiven',
    'DecrementOnCritGiven',
    'DecrementOnEffect',
    'RemoveOnDmgTaken',
  ],
}
const project = (family, records) =>
  records
    .filter(Boolean)
    .map((record) =>
      numeric(
        FIELDS[family]
          ? Object.fromEntries(
              FIELDS[family]
                .filter((key) => Object.hasOwn(record, key))
                .map((key) => [key, record[key]]),
            )
          : record,
      ),
    )
try {
  const native = JSON.parse(await readFile(join(ROOT, 'src/catalog/native-game-data.json'), 'utf8'))
  const sheet = JSON.parse(await readFile(join(ROOT, 'src/calculations/pc-1.6.9-v1.json'), 'utf8'))
  if (native.source.executable.sha256 !== sheet.source.executableSha256)
    throw new Error('Combat and sheet source identities differ')
  const rules = buildCombatRules(native)
  const families = ['monster', 'difficulty', 'status']
  const content = {
    schemaVersion: 1,
    engine: rules.id,
    nativeDataDigest: native.contentDigest,
    source: rules.source,
    enums: Object.fromEntries(
      [
        'SangAbilityAttribute',
        'SangAbilityScope',
        'SangAbilityTarget',
        'SangAbilityModTag',
        'SangStatModTag',
        'SangStatusCategory',
        'ElementType',
      ].map((name) => [name, native.enums[name]]),
    ),
    records: Object.fromEntries(
      families.map((family) => [family, project(family, native.databases[family])]),
    ),
    patches: native.databases.patch.map((patch) => ({
      name: patch.Name,
      records: Object.fromEntries(
        families.map((family) => [
          family,
          project(
            family,
            patch[
              { monster: 'Monsters', difficulty: 'Difficulties', status: 'Statuses' }[family]
            ] ?? [],
          ),
        ]),
      ),
    })),
  }
  const data = {
    ...content,
    checksum: createHash('sha256').update(JSON.stringify(content)).digest('hex'),
  }
  const schema = buildCalculationSchema(
    JSON.parse(await readFile(join(ROOT, 'src/calculations/package-v1.schema.json'), 'utf8')),
  )
  for (const [file, value] of [
    ['src/calculations/combat-v1.json', rules],
    ['src/catalog/native-combat-v1.json', data],
    ['src/calculations/package-v2.schema.json', schema],
  ]) {
    const bytes = `${JSON.stringify(value, null, 2)}\n`
    const destination = join(ROOT, file)
    if (values.check) {
      if ((await readFile(destination, 'utf8')) !== bytes)
        throw new Error(`Generated calculation drift: ${file}`)
    } else {
      await writeFile(`${destination}.tmp`, bytes)
      await rename(`${destination}.tmp`, destination)
    }
  }
  console.log(
    values.check
      ? 'Verified combat rules and numeric source projection'
      : 'Generated combat rules and numeric source projection',
  )
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
