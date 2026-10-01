#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createServer } from 'vite'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const RECEIPTS = 'src/catalog/source-corroboration.json'
const REPORT = 'docs/source-audit.json'
const EVIDENCE = 'src/catalog/game-code-evidence.json'
const OUTPUTS = new Set([RECEIPTS, REPORT, EVIDENCE])
const USAGE = `Usage: node scripts/audit-sources.mjs [-c|--check] [-r|--reference <snapshot>] [-h|--help]
Audit cited repository sources and all bundled catalog revisions. Generate portable
field corroboration receipts and a source inventory without changing catalog data.
  -c, --check                 Compare generated output with committed output
  -r, --reference <snapshot>  Verify manifest.json, installed source hashes, and
                             decompiled file hashes against reviewed code evidence
  -h, --help                  Show help
Requires Node >=22.12 and installed project dependencies. Reference verification
additionally needs the private immutable snapshot and its recorded installation.
No environment variables or network requests are used. Private paths and game
code are never written to output. Results use stdout; errors use stderr.
Exit: 0 success/help, 1 integrity/read failure, 2 invalid options.
`
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const sorted = values => [...values].sort()

function sourcesFor(value) {
  if (value?.state === 'conflicting') return value.claims.flatMap(claim => claim.sources)
  return value?.sources ?? []
}

function sourceCategory(id) {
  if (id.startsWith('native-game:')) return { disposition: 'native-game-data', reason: 'Fingerprint-pinned Windows database evidence; platform and mode scope remain explicit' }
  if (/nintendo\.com/.test(id)) return { disposition: 'retain', reason: 'Windows code cannot establish Nintendo packaging, publisher terms, or Switch version parity' }
  if (/crystal-edit-export:|equipment-expansion-sheet|spreadsheets\.google/.test(id)) return { disposition: 'retain', reason: 'Versioned mod exports and mod-specific values are not established by the base executable' }
  if (/switch:|manual:|maintainer|in-game/.test(id)) return { disposition: 'retain', reason: 'Windows corroboration does not establish the scope of a personal or Switch observation' }
  if (/fandom\.com\/licensing|license|dafont\.com|File:|Special:FilePath|static\.wikia|vignette\.wikia/.test(id)) return { disposition: 'retain', reason: 'Artwork attribution and redistribution rights are independent of gameplay corroboration' }
  if (/crystal-project\.fandom\.com|community:geef|steamcommunity|reddit\.com|youtube\.com/.test(id)) return { disposition: 'claim-specific', reason: 'Only receipts for complete claims suppress disclosures; strategy, geography, uncertainty, and partial matches retain citations' }
  if (/CrystalProjector|CrystalProjectAPWorld/.test(id)) return { disposition: 'claim-specific', reason: 'Reviewed IDs and format facts can corroborate fields; upstream attribution and format documentation remain' }
  return { disposition: 'retain', reason: 'No complete game-code proof for this citation; project, tooling, rights, and external-service references retain attribution' }
}

async function verifyReference(reference, evidence, snapshot) {
  const manifest = JSON.parse(await readFile(join(reference, 'manifest.json'), 'utf8'))
  const requiredSources = { executable: evidence.source.executableSha256, systemData: evidence.source.systemDataSha256 }
  for (const [name, expected] of Object.entries(requiredSources)) {
    const source = manifest.sources?.[name]
    if (!source || source.sha256 !== expected || hash(await readFile(source.path)) !== expected) throw new Error(`Reference ${name} does not match the reviewed installation`)
  }
  for (const [path, sha256] of Object.entries(evidence.files)) if (hash(await readFile(join(reference, 'decompiled', path))) !== sha256) throw new Error(`Reviewed code file changed: ${path}`)
  for (const [id, symbol] of Object.entries(evidence.symbols)) {
    const paths = symbol.files ?? [symbol.file]
    const contents = await Promise.all(paths.map(path => readFile(join(reference, 'decompiled', path), 'utf8')))
    for (const member of symbol.members ?? []) if (!contents.some(content => content.includes(member))) throw new Error(`Reviewed member is missing: ${id}/${member}`)
    if (symbol.tag && paths.length && !contents.some(content => content.includes(symbol.tag))) throw new Error(`Reviewed modifier is missing: ${id}`)
  }
  const content = dirname(manifest.sources.systemData.path)
  for (const file of snapshot.source.files) if (hash(await readFile(join(content, file.path.replace(/^Database\//, '')))) !== file.sha256) throw new Error(`Native database changed: ${file.path}`)
}

export async function auditSources({ check = false, reference } = {}) {
  const evidence = JSON.parse(await readFile(join(ROOT, EVIDENCE), 'utf8'))
  const snapshot = JSON.parse(await readFile(join(ROOT, 'src/catalog/native-game-data.json'), 'utf8'))
  if (evidence.source.executableSha256 !== snapshot.source.executable.sha256 || evidence.source.systemDataSha256 !== snapshot.source.files.find(file => file.path === 'Database/system.dat')?.sha256) throw new Error('Reviewed code and bundled native snapshot fingerprints differ')
  if (reference) await verifyReference(reference, evidence, snapshot)
  for (const symbol of Object.values(evidence.symbols)) for (const path of symbol.files ?? [symbol.file]) if (!Object.hasOwn(evidence.files, path) || !/^[a-f0-9]{64}$/.test(evidence.files[path])) throw new Error('Code locator has no pinned file hash')
  for (const mechanic of Object.values(evidence.mechanics)) if (!['corroborated', 'partial'].includes(mechanic.status) || mechanic.evidence.some(id => !Object.hasOwn(evidence.symbols, id))) throw new Error('Mechanic review has invalid evidence')
  const server = await createServer({ root: ROOT, configFile: false, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
  try {
    const { BUNDLED_CATALOGS } = await server.ssrLoadModule('/src/catalog/bundled.ts')
    const { assessCatalogField } = await server.ssrLoadModule('/src/catalog/source-corroboration-rules.ts')
    const trees = JSON.parse(await readFile(join(ROOT, 'src/catalog/class-tree-identities.json'), 'utf8'))
    const identities = Object.fromEntries(Object.entries(snapshot.identityBindings).map(([key, id]) => { const [database, databaseId] = key.split(':'); return [id, { database, databaseId: Number(databaseId) }] }))
    const ambiguousIdentities = new Set()
    for (const [database, sha256] of Object.entries(trees.databaseSha256)) if (snapshot.source.files.find(file => file.path === `Database/${database}.dat`)?.sha256 !== sha256) throw new Error('Class-tree identities and native database fingerprints differ')
    for (const entry of Object.values(trees.classes)) for (const node of entry.nodes) {
      if (!node.entityId) continue
      const job = snapshot.databases.job.find(record => record?.ID === entry.nativeJobId)
      const original = job?.LearnTree?.[node.column]?.[node.row]
      const database = ['ability', 'monsterMagic'].includes(node.kind) ? 'ability' : node.kind === 'passive' || node.kind === 'innate' ? 'passive' : undefined
      if (!original || original.DataID !== node.dataId || !database || original.NodeType !== (database === 'ability' ? 2 : 3)) throw new Error(`Class-tree identity is not present in its native learn tree: ${node.entityId}`)
      const identity = { database, databaseId: node.dataId }
      if (identities[node.entityId] && JSON.stringify(identities[node.entityId]) !== JSON.stringify(identity)) ambiguousIdentities.add(node.entityId)
      identities[node.entityId] = identity
    }
    for (const id of ambiguousIdentities) delete identities[id]
    const context = { snapshot, identities, mechanics: evidence.mechanics }
    const inventory = new Map()
    const source = id => {
      if (!inventory.has(id)) inventory.set(id, { ...sourceCategory(id), files: new Set(), catalogs: new Set(), outcomes: { corroborated: 0, partial: 0, retained: 0 }, reasons: new Set() })
      return inventory.get(id)
    }
    const catalogs = []
    const proofs = []
    const proofIds = new Map()
    for (const catalog of BUNDLED_CATALOGS) {
      const fields = {}
      const catalogKey = `${catalog.id}@${catalog.revisionId}`
      for (const entity of Object.values(catalog.entities)) {
        for (const ref of entity.sources) source(ref.sourceId).catalogs.add(catalogKey)
        for (const [field, knowledge] of Object.entries(entity.fields)) {
          const refs = sourcesFor(knowledge)
          if (!refs.length) continue
          const nativeOnly = knowledge.state === 'known' && refs.every(ref => ref.sourceId.startsWith('native-game:'))
          const assessment = nativeOnly ? { status: 'corroborated', reason: 'Direct normalized native database evidence', evidence: [] } : assessCatalogField(context, entity, field, knowledge)
          if (!nativeOnly && assessment.status === 'corroborated') {
            fields[entity.id] ??= {}
            const proofKey = JSON.stringify(assessment.evidence)
            if (!proofIds.has(proofKey)) { proofIds.set(proofKey, proofs.length); proofs.push(assessment.evidence) }
            fields[entity.id][field] = proofIds.get(proofKey)
          }
          for (const ref of refs) {
            const entry = source(ref.sourceId)
            entry.catalogs.add(catalogKey)
            entry.outcomes[assessment.status]++
            entry.reasons.add(assessment.reason)
          }
        }
        for (const field of ['slotKinds', 'ppCost', 'requirements', 'grants']) for (const ref of sourcesFor(entity[field])) {
          const entry = source(ref.sourceId)
          entry.catalogs.add(catalogKey)
          entry.reasons.add('Planning projections retain source provenance and do not gain platform parity')
        }
      }
      for (const claim of catalog.claims) for (const ref of [...claim.sources, ...sourcesFor(claim.value)]) {
        const entry = source(ref.sourceId)
        entry.catalogs.add(catalogKey)
        entry.outcomes.retained++
        entry.reasons.add('Original auxiliary claims remain unchanged')
      }
      catalogs.push({ catalogId: catalog.id, revisionId: catalog.revisionId, checksum: catalog.checksum, fields })
    }
    const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(file => file && !OUTPUTS.has(file) && /\.(?:ts|tsx|mjs|json|md|css|txt|html|yaml|yml)$/.test(file) && !/(?:\.test\.|\.spec\.|^e2e\/|package-lock\.json$)/.test(file))
    for (const file of new Set(files)) {
      const content = await readFile(join(ROOT, file), 'utf8')
      for (const match of content.matchAll(/https?:\/\/[^\s"'<>`\\]+/g)) {
        let id = match[0].replace(/[.,;\]}]+$/, '')
        while (id.endsWith(')') && [...id].filter(c => c === '(').length < [...id].filter(c => c === ')').length) id = id.slice(0, -1)
        if (id.includes('${') || id.includes('example.') || id.includes('localhost') || id.includes('127.0.0.1')) continue
        try { if (!new URL(id).hostname) continue } catch { continue }
        source(id).files.add(file)
      }
      if (file.endsWith('.json')) {
        const visit = value => {
          if (Array.isArray(value)) value.forEach(visit)
          else if (value && typeof value === 'object') {
            if (typeof value.sourceId === 'string') source(value.sourceId).files.add(file)
            Object.values(value).forEach(visit)
          }
        }
        visit(JSON.parse(content))
      }
    }
    for (const claim of evidence.featureClaims) for (const id of claim.sources) {
      const entry = source(id)
      entry.outcomes[claim.assessment]++
      entry.reasons.add(claim.reason)
    }
    const receipts = { schemaVersion: 1, source: evidence.source, proofs, catalogs }
    const report = { schemaVersion: 1, source: evidence.source, policy: 'Complete unchanged known claims only; original attribution and immutable catalogs are preserved', featureClaims: evidence.featureClaims, ambiguousIdentities: sorted(ambiguousIdentities), sources: Object.fromEntries([...inventory].sort(([a], [b]) => a.localeCompare(b)).map(([id, entry]) => [id, { ...entry, files: sorted(entry.files), catalogs: sorted(entry.catalogs), reasons: sorted(entry.reasons) }])) }
    for (const [file, data] of [[RECEIPTS, receipts], [REPORT, report]]) {
      const output = `${JSON.stringify(data, null, 2)}\n`
      if (check) {
        if (await readFile(join(ROOT, file), 'utf8') !== output) throw new Error(`Source audit is stale: ${file}`)
      } else await writeFile(join(ROOT, file), output)
    }
    const count = catalogs.reduce((sum, catalog) => sum + Object.values(catalog.fields).reduce((n, fields) => n + Object.keys(fields).length, 0), 0)
    console.log(`${check ? 'Verified' : 'Generated'} source audit: ${inventory.size} citations; ${count} field receipts across ${catalogs.length} immutable catalog revisions`)
  } finally { await server.close() }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  let values
  try { ({ values } = parseArgs({ options: { check: { type: 'boolean', short: 'c' }, reference: { type: 'string', short: 'r' }, help: { type: 'boolean', short: 'h' } }, allowPositionals: false })) }
  catch (error) { console.error(error.message); process.exitCode = 2 }
  if (values?.help) console.log(USAGE)
  else if (values) {
    if (values.reference === '') { console.error('--reference requires a nonempty snapshot path'); process.exitCode = 2 }
    else try { await auditSources(values) } catch (error) { console.error(error.message); process.exitCode = 1 }
  }
}
