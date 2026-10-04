#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createServer } from 'vite'
import { validateModSnapshot } from './bundle-mod.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const RECEIPT = join(ROOT, 'src/catalog/certainty-catalog.json')
const REPORT = join(ROOT, 'docs/catalog-certainty.json')
const USAGE = `Usage: node scripts/audit-certainty.mjs [-c|--check] [-h|--help]
Audit the default catalog's field and planning certainty, remaining source gaps,
exact identity reconciliation, and immutable catalog content checksum. Update
the portable receipt and report, or compare them offline with --check.
Requires Node >=22.12 and installed project dependencies. No installation,
environment variables, or network requests are used. Results go to stdout;
errors go to stderr. Exit: 0 success/help, 1 integrity/read failure, 2 usage.
`
let values
try { values = parseArgs({ options: { check: { type: 'boolean', short: 'c' }, help: { type: 'boolean', short: 'h' } }, allowPositionals: false }).values }
catch (error) { console.error(error.message); process.exit(2) }
if (values.help) { process.stdout.write(USAGE); process.exit(0) }
let server
try {
  validateModSnapshot(JSON.parse(await readFile(join(ROOT, 'src/catalog/moonlight-project-v2.2.json'), 'utf8')))
  server = await createServer({ root: ROOT, configFile: false, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
  const { DEFAULT_CATALOG: catalog } = await server.ssrLoadModule('/src/catalog/bundled.ts')
  const { catalogContentForChecksum } = await server.ssrLoadModule('/src/interchange/catalog-checksum.ts')
  const { checksum: _checksum, ...content } = catalog
  const checksum = `builtin:sha256:${createHash('sha256').update(catalogContentForChecksum(content)).digest('hex')}`
  const receipt = { schemaVersion: 1, revisionId: catalog.revisionId, checksum }
  const states = { known: 0, unknown: 0, conflicting: 0, notApplicable: 0 }
  const gaps = new Map()
  for (const entity of Object.values(catalog.entities)) for (const [field, value] of [...Object.entries(entity.fields), ...['slotKinds', 'ppCost', 'requirements', 'grants'].flatMap(field => entity[field] ? [[field, entity[field]]] : [])]) {
    states[value.state]++
    if (value.state !== 'unknown' && value.state !== 'conflicting') continue
    const reason = value.reason ?? (value.state === 'conflicting' ? 'Original source claims differ' : 'No source value supplied')
    const key = JSON.stringify([value.state, entity.kind, field, reason])
    const gap = gaps.get(key) ?? { state: value.state, kind: entity.kind, field, reason, count: 0, examples: [] }
    gap.count++
    if (gap.examples.length < 3) gap.examples.push(entity.id)
    gaps.set(key, gap)
  }
  const { nativeDescription } = await server.ssrLoadModule('/src/catalog/native-description.ts')
  const { nativeFieldFacts } = await server.ssrLoadModule('/src/catalog/native-field-facts.ts')
  const { nativeEquipmentFacts } = await server.ssrLoadModule('/src/catalog/native-equipment-facts.ts')
  const { projectAcquisitionGuidance } = await server.ssrLoadModule('/src/catalog/acquisition-guidance.ts')
  const { NATIVE_REFERENCE_LINKS } = await server.ssrLoadModule('/src/catalog/native-reference-links.ts')
  const descriptionFamilies = new Set(['equipment', 'passive', 'item', 'ability', 'status'])
  const { nativeIdentity } = await server.ssrLoadModule('/src/domain/native-game.ts')
  const presentation = {
    scope: 'Read-only native projections; stored source states and immutable catalog content remain unchanged',
    descriptions: { complete: 0, partial: 0, unsupported: 0, historicalFallbacks: { complete: 0, partial: 0, unsupported: 0 }, unsupportedReasons: {} },
    fieldFacts: { nativeValues: 0, differingOriginals: 0, archivedEquipmentFields: 0 },
    acquisition: { replacedFields: 0, retainedGuideFields: 0, disagreements: 0 },
    identities: { relations: {}, dispositions: {} },
  }
  for (const entity of Object.values(catalog.entities)) {
    const description = nativeDescription(entity)
    if (description && descriptionFamilies.has(nativeIdentity(entity)?.database)) {
      const disposition = description.complete ? 'complete' : description.lines.length ? 'partial' : 'unsupported'
      presentation.descriptions[disposition]++
      if (entity.legacy?.nativeDescriptionSupplemental === true) presentation.descriptions.historicalFallbacks[disposition]++
      for (const reason of description.unresolved) presentation.descriptions.unsupportedReasons[reason] = (presentation.descriptions.unsupportedReasons[reason] ?? 0) + 1
    }
    const fieldFacts = nativeFieldFacts(catalog, entity)
    const equipment = nativeEquipmentFacts(catalog, entity)
    presentation.fieldFacts.nativeValues += new Set([...fieldFacts, ...equipment?.facts ?? []].map(fact => fact.field)).size
    presentation.fieldFacts.archivedEquipmentFields += equipment?.archivedFields.length ?? 0
    for (const fact of fieldFacts) {
      if (fact.differs) presentation.fieldFacts.differingOriginals++
    }
    if (entity.kind === 'item') {
      const guidance = projectAcquisitionGuidance(catalog, entity)
      presentation.acquisition.replacedFields += guidance.replacedFields.length
      presentation.acquisition.retainedGuideFields += guidance.retainedGuides.length
      presentation.acquisition.disagreements += guidance.disagreements.length
    }
  }
  for (const { relation } of NATIVE_REFERENCE_LINKS.links) presentation.identities.relations[relation] = (presentation.identities.relations[relation] ?? 0) + 1
  for (const { disposition } of NATIVE_REFERENCE_LINKS.dispositions) presentation.identities.dispositions[disposition] = (presentation.identities.dispositions[disposition] ?? 0) + 1
  const report = { schemaVersion: 2, presentation, catalogId: catalog.id, revisionId: catalog.revisionId, checksum, states, scope: 'Catalog definitions only; personal observations and unrecorded Game Setup choices retain their knowledge states', gaps: [...gaps.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) }
  for (const [file, value] of [[RECEIPT, receipt], [REPORT, report]]) {
    const serialized = `${JSON.stringify(value, null, 2)}\n`
    if (values.check) { if (await readFile(file, 'utf8') !== serialized) throw new Error(`${file.slice(ROOT.length + 1)} is stale`) }
    else await writeFile(file, serialized)
  }
  console.log(`${values.check ? 'Verified' : 'Audited'} ${catalog.revisionId}: ${states.known} known, ${states.notApplicable} inapplicable, ${states.unknown} source gaps, ${states.conflicting} stored source differences`)
} catch (error) { console.error(error.message); process.exitCode = 1 }
finally { await server?.close() }
