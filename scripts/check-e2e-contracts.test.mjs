import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectE2EContracts, checkE2EContracts } from './check-e2e-contracts.mjs'

const script = fileURLToPath(new URL('./check-e2e-contracts.mjs', import.meta.url))

test('rejects the stale Summons assertion and catalog paths in strings, templates, and regexes', () => {
  const sources = [
    "new RegExp(`/entities/${summon.id.split(':').join('/')}(?:\\\\?|$)`)",
    "page.goto('/#/reference/catalog/fixture/revisions/r1/entities/base/monster/1/slime')",
    String.raw`expect(link).toHaveAttribute('href', /base\/scholar\/monster-magic\/adrenaline$/)`,
    String.raw`expect(page).toHaveURL(/\/316\/mode\/Chaos\//)`,
    "const path = id.split(':').map(encodeURIComponent).join('/')",
  ]
  for (const source of sources) assert.equal(inspectE2EContracts('e2e/summons.spec.ts', source).length, 1, source)
  assert.match(inspectE2EContracts('e2e/feature.spec.ts', '\n' + sources[0])[0], /feature.spec.ts:2:/)
})

test('allows helpers and dedicated route contracts without broad filename exceptions', () => {
  assert.deepEqual(inspectE2EContracts('e2e/feature.spec.ts', "expect(link).toHaveAttribute('href', referencePath('base:monster:1').slice(1))"), [])
  assert.deepEqual(inspectE2EContracts('e2e/entity-urls.spec.ts', "page.goto('/#/reference/catalog/fixture/revisions/r1/entities/base/monster/1/slime')"), [])
  assert.equal(inspectE2EContracts('e2e/nested/entity-urls.spec.ts', "page.goto('/entities/base/monster/1/slime')").length, 1)
})

test('CLI exposes help, rejects invalid arguments, and recursively reports source locations', () => {
  const directory = mkdtempSync(join(tmpdir(), 'crykit-e2e-contracts-'))
  const cli = (...args) => execFileSync(process.execPath, [script, ...args], { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    for (const flag of ['-h', '--help']) assert.match(cli(flag), /Usage:/)
    for (const args of [['--bad'], ['--help='], ['--', 'file.ts']]) assert.throws(() => cli(...args), error => error.status === 2 && error.stdout === '')
    mkdirSync(join(directory, 'e2e/nested'), { recursive: true })
    writeFileSync(join(directory, 'e2e/feature.spec.ts'), "const url = referencePath('base:monster:1')")
    assert.match(cli('--'), /passed/)
    writeFileSync(join(directory, 'e2e/nested/feature.spec.ts'), "const url = '/entities/base/monster/1/slime'")
    assert.throws(() => cli(), error => error.status === 1 && /e2e\/nested\/feature.spec.ts:1:/.test(error.stderr) && error.stdout === '')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('the repository feature tests use the shared reference contracts', () => {
  assert.deepEqual(checkE2EContracts(), [])
})
