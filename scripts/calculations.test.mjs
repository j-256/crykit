import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fromJSONSchema } from 'zod'
import { calculationPackage } from '../src/domain/calculation-package.ts'

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
test('export CLI and browser package share the pinned numeric sources without private inputs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'crystal-calculations-'))
  try {
    const output = join(directory, 'calculations.json')
    execFileSync(process.execPath, ['scripts/export-calculations.mjs', '--output', output])
    const exported = JSON.parse(readFileSync(output, 'utf8'))
    assert.equal(exported.format, 'crystal-project-calculations')
    assert.equal(exported.schemaVersion, 2)
    assert.deepEqual(exported, calculationPackage())
    const schema = fromJSONSchema(
      JSON.parse(readFileSync('src/calculations/package-v2.schema.json', 'utf8')),
    )
    const validated = schema.safeParse(exported)
    assert.ok(validated.success, validated.error?.message)
    assert.equal(exported.rules.id, exported.data.engine)
    assert.equal(exported.rules.source.executableSha256, exported.data.executableSha256)
    assert.equal(
      exported.data.nativeDataDigest,
      JSON.parse(readFileSync('src/catalog/native-game-data.json', 'utf8')).contentDigest,
    )
    const { checksum, ...content } = exported.data
    assert.equal(hash(content), checksum)
    assert.deepEqual(
      exported.rules,
      JSON.parse(readFileSync('src/calculations/pc-1.6.9-v1.json', 'utf8')),
    )
    assert.deepEqual(
      exported.legacy,
      JSON.parse(readFileSync('src/calculations/guide-v1.json', 'utf8')),
    )
    const data = JSON.stringify(exported)
    assert.doesNotMatch(data, /\/Users\/|playthroughs|personalDefinitions|displayedStats/)
    for (const [entityId, binding] of Object.entries(exported.data.bindings)) {
      assert.ok(
        exported.data.records[binding.family].some((record) => record.ID === binding.id),
        entityId,
      )
      assert.ok(binding.evidence)
    }
    assert.equal(
      JSON.stringify(exported),
      JSON.stringify(
        JSON.parse(
          execFileSync(process.execPath, ['scripts/export-calculations.mjs'], {
            encoding: 'utf8',
            maxBuffer: 32 * 1024 * 1024,
          }),
        ),
      ),
    )
    const { checksum: combatChecksum, ...combatContent } = exported.combatData
    assert.equal(hash(combatContent), combatChecksum)
    assert.equal(exported.combatData.nativeDataDigest, exported.data.nativeDataDigest)
    assert.equal(
      exported.combatVerification.evidence.executableSha256,
      exported.data.executableSha256,
    )
    for (const method of exported.combatVerification.evidence.calculatorMethods) {
      const location = exported.combat.coverage.calculator[method]
      assert.ok(location, `Missing Calculator method: ${method}`)
      assert.ok(
        exported[location.module].formulas[location.formula],
        `Missing implementation: ${method}`,
      )
    }
    for (const vector of exported.combatVerification.cases) {
      assert.ok(exported.combat.formulas[vector.formula])
      assert.equal(vector.input.length, exported.combat.formulas[vector.formula].inputs.length)
      assert.ok(
        vector.input.every(
          (index) =>
            Number.isInteger(index) &&
            index >= 0 &&
            index < exported.combatVerification.values.length,
        ),
      )
    }
    const malformed = structuredClone(exported)
    malformed.combat.formulas.periodicHP.result = ['execute', 1]
    assert.equal(schema.safeParse(malformed).success, false)
    malformed.combat.formulas.periodicHP.result = ['if', true, 1]
    assert.equal(schema.safeParse(malformed).success, false)
  } finally {
    rmSync(directory, { recursive: true })
  }
})

test('format 1 remains byte-equivalent to the original package shape', () => {
  const exported = execFileSync(
    process.execPath,
    ['scripts/export-calculations.mjs', '--schema-version', '1'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  )
  assert.equal(exported, JSON.stringify(calculationPackage(1), null, 2) + '\n')
  const schema = fromJSONSchema(
    JSON.parse(readFileSync('src/calculations/package-v1.schema.json', 'utf8')),
  )
  assert.ok(schema.safeParse(JSON.parse(exported)).success)
  for (const version of ['', '0', '3', '2.5'])
    assert.equal(
      spawnSync(process.execPath, ['scripts/export-calculations.mjs', '--schema-version', version])
        .status,
      2,
    )
})

test('every arithmetic formula has valid calls, source evidence, and a generated reference entry', () => {
  const exported = calculationPackage()
  const reference = readFileSync('docs/calculation-reference.md', 'utf8')
  const abilityFields = new Set()
  for (const [section, rules] of [
    ['sheet', exported.rules],
    ['combat', exported.combat],
    ['legacy', exported.legacy],
  ]) {
    const visit = (expression) => {
      if (
        section === 'combat' &&
        typeof expression === 'string' &&
        /^ability\.[A-Za-z0-9_]+$/.test(expression)
      )
        abilityFields.add(expression.slice('ability.'.length))
      if (!Array.isArray(expression)) return
      if (expression[0] === 'call') {
        const callee = rules.formulas[expression[1]]
        assert.ok(callee, `Undefined ${section} formula ${expression[1]}`)
        assert.equal(expression.length - 2, callee.inputs.length)
      }
      expression.slice(1).forEach(visit)
    }
    for (const [id, formula] of Object.entries(rules.formulas)) {
      assert.ok(formula.evidence?.length, `Missing evidence: ${section}/${id}`)
      if (section === 'combat')
        for (const source of formula.evidence) {
          if (source.startsWith('Microsoft.Xna.Framework.')) {
            assert.match(exported.combatVerification.evidence.fnaSha256, /^[a-f0-9]{64}$/)
            continue
          }
          const file = source.split('.').slice(0, -1).join('/') + '.cs'
          assert.match(
            rules.source.files[file] ?? '',
            /^[a-f0-9]{64}$/,
            `Unpinned formula source: ${source}`,
          )
        }
      assert.equal(new Set(formula.inputs).size, formula.inputs.length)
      formula.steps.forEach((step) => visit(step.value))
      formula.requirements?.forEach((requirement) => visit(requirement.condition))
      visit(formula.result)
      assert.ok(
        reference.includes(`<a id="${section}-${id.toLowerCase()}"></a>`),
        `Undocumented formula: ${section}/${id}`,
      )
    }
  }
  for (const ability of exported.data.records.ability)
    for (const field of abilityFields)
      assert.ok(
        Object.hasOwn(ability, field),
        `Ability ${ability.ID} is missing required field ${field}`,
      )
})

test('calculation CLIs separate help, usage errors and runtime checks', () => {
  for (const script of [
    'scripts/export-calculations.mjs',
    'scripts/update-native-stats.mjs',
    'scripts/update-combat-calculations.mjs',
    'scripts/render-calculation-reference.mjs',
  ]) {
    const help = spawnSync(process.execPath, [script, '-h'], { encoding: 'utf8' })
    assert.equal(help.status, 0)
    assert.match(help.stdout, /Usage:/)
    assert.equal(help.stderr, '')
    const invalid = spawnSync(process.execPath, [script, '--invalid'], { encoding: 'utf8' })
    assert.equal(invalid.status, 2)
    assert.equal(invalid.stdout, '')
    assert.ok(invalid.stderr)
  }
  assert.equal(
    spawnSync(process.execPath, ['scripts/update-native-stats.mjs', '--check']).status,
    0,
  )
  assert.equal(
    spawnSync(process.execPath, ['scripts/update-combat-calculations.mjs', '--check']).status,
    0,
  )
  assert.equal(
    spawnSync(process.execPath, ['scripts/render-calculation-reference.mjs', '--check']).status,
    0,
  )
})
