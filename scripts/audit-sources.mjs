#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { createServer } from 'vite'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const REPORT = join(ROOT, 'docs/source-audit.json')
const HELP = `Usage: node scripts/audit-sources.mjs [-c|--check] [-h|--help]
Audit native definitions, focused supplements, and source fingerprints. Write
or verify docs/source-audit.json without private files or network access.
Requires Node >=22.12 and installed project dependencies.
  -c, --check  Verify the committed report without writing
  -h, --help   Show help
Results go to stdout; errors go to stderr. Exit: 0 success/help,
1 source/integrity/read failure, 2 invalid options, 3 missing dependencies.
`

export async function auditSources({ check = false } = {}) {
  const server = await createServer({ root: ROOT, configFile: false, logLevel: 'error', server: { middlewareMode: true, hmr: false }, appType: 'custom' })
  try {
    const { BUNDLED_CATALOGS } = await server.ssrLoadModule('/src/catalog/bundled.ts')
    const { NATIVE_GAME_DATA } = await server.ssrLoadModule('/src/catalog/native-game.ts')
    const { nativeMechanicDefinitions } = await server.ssrLoadModule('/src/catalog/native-mechanics.ts')
    const { catalogContentForChecksum } = await server.ssrLoadModule('/src/interchange/catalog-checksum.ts')
    const mechanics = nativeMechanicDefinitions()
    if (BUNDLED_CATALOGS.length !== 1 || BUNDLED_CATALOGS[0].id !== 'crystal-project/vanilla') throw new Error('Only the native vanilla catalog may ship in the launch collection')
    const catalogs = BUNDLED_CATALOGS.map(catalog => {
      const sources = new Set()
      const visit = value => {
        if (!value || typeof value !== 'object') return
        if (typeof value.sourceId === 'string') {
          if (!value.sourceId.startsWith('native-game:')) throw new Error(`Non-native source in bundled catalog: ${value.sourceId}`)
          sources.add(value.sourceId)
        }
        for (const child of Object.values(value)) visit(child)
      }
      visit(catalog)
      const { checksum, ...content } = catalog
      if (checksum !== `builtin:sha256:${createHash('sha256').update(catalogContentForChecksum(content)).digest('hex')}`) throw new Error('Native catalog checksum differs')
      for (const [id, entity] of Object.entries(mechanics)) if (JSON.stringify(catalog.entities[id]) !== JSON.stringify(entity)) throw new Error(`Native mechanic differs: ${id}`)
      return { id: catalog.id, revisionId: catalog.revisionId, checksum, definitions: Object.keys(catalog.entities).length, sourceIds: [...sources].sort() }
    })
    const guidance = JSON.parse(await readFile(join(ROOT, 'src/catalog/reference-guidance.json'), 'utf8'))
    const { referenceGuidance } = await server.ssrLoadModule('/src/catalog/reference-guidance.ts')
    const { QUINTAR_GUIDE_SUPPLEMENT } = await server.ssrLoadModule('/src/catalog/quintar-guide-supplement.ts')
    const menuIcons = JSON.parse(await readFile(join(ROOT, 'src/catalog/menu-icon-supplements.json'), 'utf8'))
    const catalog = BUNDLED_CATALOGS[0]
    const guidanceSources = new Set()
    for (const record of guidance.records) {
      const entity = catalog.entities[record.entityId]
      if (!entity || !referenceGuidance(catalog, entity, record.kind).some(admitted => admitted.text === record.text)) throw new Error(`Supplement does not match its native record: ${record.entityId}`)
      if (!record.sources.length) throw new Error(`Supplement has no attribution: ${record.entityId}`)
      for (const source of record.sources) guidanceSources.add(source.sourceId)
    }
    const supplements = {
      guidance: { records: guidance.records.length, sourceIds: [...guidanceSources].sort(), rights: guidance.rights },
      quintar: { source: QUINTAR_GUIDE_SUPPLEMENT.source },
      menuIcons: { keys: Object.keys(menuIcons.icons).sort(), rights: 'Original artwork file declarations retained in menu-icon-supplements.json' },
    }
    const report = { schemaVersion: 1, scope: 'Native vanilla definitions and reviewed mechanics, with separately attributed focused guidance and glyph supplements; private imports retain their own attribution', source: NATIVE_GAME_DATA.source, catalogs, supplements }
    const serialized = `${JSON.stringify(report, null, 2)}\n`
    if (check) { if (await readFile(REPORT, 'utf8') !== serialized) throw new Error('Source audit report is stale') }
    else await writeFile(REPORT, serialized)
    return { catalogs: catalogs.length, definitions: catalogs.reduce((total, catalog) => total + catalog.definitions, 0) }
  } finally { await server.close() }
}

async function main() {
  let values
  try { values = parseArgs({ options: { check: { type: 'boolean', short: 'c' }, help: { type: 'boolean', short: 'h' } }, allowPositionals: false }).values }
  catch (error) { process.stderr.write(`${error.message}\n${HELP}`); process.exitCode = 2; return }
  if (values.help) { process.stdout.write(HELP); return }
  try { process.stdout.write(`${JSON.stringify(await auditSources(values))}\n`) }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = error.code === 'ERR_MODULE_NOT_FOUND' ? 3 : 1 }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
