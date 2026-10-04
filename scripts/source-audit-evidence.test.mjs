import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { citationSourceId, PROJECTION_EVIDENCE, validateProjectionEvidence } from './source-audit-evidence.mjs'

const load = path => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url)))
const context = {
  evidence: load('src/catalog/game-code-evidence.json'),
  snapshot: load('src/catalog/native-game-data.json'),
  combat: load('src/calculations/combat-v1.json'),
  world: load('src/catalog/world-acquisition-v1.json'),
}
const validate = (file, receipt) => validateProjectionEvidence(file, receipt, { ...context, reviewedFiles: context.evidence.files })

test('entity relationship receipts do not become source citations', () => {
  assert.equal(citationSourceId({ sourceId: 'base:item:legacy', targetId: 'base:item:10', relation: 'same-definition' }), undefined)
  assert.equal(citationSourceId({ sourceId: 'legacy-guide', entityId: 'base:guide:1', expectedFields: {} }), undefined)
  assert.equal(citationSourceId({ sourceId: 'native-game:windows:1.6.9', locator: 'Database/item.dat/10' }), 'native-game:windows:1.6.9')
  assert.equal(citationSourceId({ sourceId: 'https://example.org/source' }), 'https://example.org/source')
  assert.equal(citationSourceId({ sourceId: 'manual-observation', entityId: 'item' }), 'manual-observation')
})

test('reviewed projections require their source scope and nonempty code evidence', () => {
  for (const file of PROJECTION_EVIDENCE) {
    const receipt = load(file)
    assert.ok(Object.keys(validate(file, receipt).files).length)
    if (receipt.source) {
      const requiredSourceKeys = file.endsWith('acquisition-route-facts.json') ? ['platform', 'gameVersion', 'gameExecutableSha256', 'nativeContentDigest', 'worldContentDigest', 'worldSha256'] : ['platform', 'gameVersion', 'executableSha256', 'systemDataSha256']
      for (const key of requiredSourceKeys) {
        const source = { ...receipt.source }
        delete source[key]
        assert.throws(() => validate(file, { ...receipt, source }), /source fingerprints differ/)
      }
      for (const files of [undefined, {}, []]) assert.throws(() => validate(file, { ...receipt, files }), /code files are missing/)
      const files = { ...receipt.files }
      delete files[Object.keys(files)[0]]
      assert.throws(() => validate(file, { ...receipt, files }), /Required projection code evidence is missing/)
    } else {
      for (const key of ['gameExecutableSha256', 'nativeContentDigest', 'code']) {
        const changed = { ...receipt }
        delete changed[key]
        assert.throws(() => validate(file, changed), /fingerprints differ|code evidence is missing/)
      }
      assert.throws(() => validate(file, { ...receipt, code: { ...receipt.code, members: [] } }), /code evidence is missing/)
    }
  }
})

test('projection validation rejects drift, calculation overrides, and malformed code paths', () => {
  const descriptionFile = PROJECTION_EVIDENCE[0]
  const description = load(descriptionFile)
  assert.throws(() => validate(descriptionFile, { ...description, source: { ...description.source, contentDigest: '0'.repeat(64) } }), /incomplete/)
  assert.throws(() => validate(descriptionFile, { ...description, files: { ...description.files, '../private.cs': '0'.repeat(64) } }), /Invalid projection code locator/)
  assert.throws(() => validate(descriptionFile, { ...description, files: { ...description.files, 'Sang/Window/WindowHelper.cs': '0'.repeat(64) } }), /code fingerprint differs/)
  const mechanicsFile = PROJECTION_EVIDENCE[1]
  const mechanics = load(mechanicsFile)
  assert.throws(() => validate(mechanicsFile, { ...mechanics, calculationFiles: {} }), /code files are missing/)
  assert.throws(() => validate(mechanicsFile, { ...mechanics, calculationFiles: { 'Sang/Battle/RollResolver.cs': '0'.repeat(64) } }), /calculation fingerprint differs/)
  assert.throws(() => validate(mechanicsFile, { ...mechanics, entries: [] }), /incomplete/)
  assert.throws(() => validate('src/catalog/unknown.json', description), /Unknown or invalid/)
})

test('acquisition price receipts bind native world facts and explicit choice costs', () => {
  const file = 'src/catalog/acquisition-route-facts.json'
  const receipt = load(file)
  assert.throws(() => validate(file, { ...receipt, source: { ...receipt.source, worldContentDigest: '0'.repeat(64) } }), /source fingerprints differ/)
  assert.throws(() => validate(file, { ...receipt, prices: [] }), /incomplete/)
  const price = receipt.prices[0]
  assert.throws(() => validate(file, { ...receipt, prices: [{ ...price, choice: { ...price.choice, cost: price.price + 1 } }] }), /incomplete/)
  assert.throws(() => validate(file, { ...receipt, prices: [{ ...price, choice: { ...price.choice, isCostOfItem: true } }] }), /incomplete/)
})
