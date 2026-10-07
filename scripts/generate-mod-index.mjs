#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gzipSync, gunzipSync } from 'node:zlib'
import { parseArgs } from 'node:util'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const INDEX = 'src/catalog/bundled-mod-index.json'
const VANILLA_RECEIPT = 'src/catalog/vanilla-catalog-v3.json'
const VANILLA_PACKED = 'src/catalog/vanilla-catalog-v3.packed.json'
const GENERATED_AT = '1970-01-01T00:00:00.000Z'
const MAX_SOURCE_BYTES = 96 * 1024 * 1024
const GZIP_OS_OFFSET = 9
const GZIP_OS_UNKNOWN = 255
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const HELP = `Usage: node scripts/generate-mod-index.mjs [-c|--check] [-h|--help]
Generate a compact search catalog for every directory-bundled Crystal Edit source
using the application's import interpreter. Preserve full originals unchanged.
Read src/catalog/bundled-mod-sources.json, digest-named gzip/base64 source assets,
native databases and attributed reference sources. Write the mod search index,
independent vanilla catalog snapshot and checksum receipt. Requires Node >=22.12
and npm ci dependencies. No
environment variables, private inputs, or network requests are used.
  -c, --check  Verify generated outputs without writing
  -h, --help   Show help
Results use stdout; diagnostics use stderr. Exit: 0 success/help, 1 content or
integrity failure, 2 invalid options, 3 missing dependencies.
`

function packedJson(value) {
  const json = JSON.stringify(value)
  const compressed = gzipSync(json, { level: 9 })
  // The gzip OS byte varies by platform even for identical input; neutralize it for reproducible snapshots
  compressed[GZIP_OS_OFFSET] = GZIP_OS_UNKNOWN
  return `${JSON.stringify({ schemaVersion: 1, encoding: 'gzip-base64', sha256: digest(json), data: compressed.toString('base64') })}\n`
}

export async function generateModIndex({ check = false } = {}) {
  const { createServer } = await import('vite')
  const server = await createServer({ root: ROOT, configFile: false, logLevel: 'error', server: { middlewareMode: true, hmr: false }, appType: 'custom' })
  try {
    const manifest = JSON.parse(await readFile(join(ROOT, 'src/catalog/bundled-mod-sources.json'), 'utf8'))
    const { vanillaCatalog } = await server.ssrLoadModule('/src/catalog/vanilla-catalog.ts')
    const { catalogContentForChecksum } = await server.ssrLoadModule('/src/interchange/catalog-checksum.ts')
    const { immutableCatalogSnapshot } = await server.ssrLoadModule('/src/interchange/native.ts')
    const { previewCrystalEdit } = await server.ssrLoadModule('/src/interchange/crystal-edit.ts')
    const { modSearchCatalog } = await server.ssrLoadModule('/src/domain/mod-search.ts')
    const { checksum: _checksum, ...content } = vanillaCatalog('')
    const checksum = `builtin:sha256:${digest(catalogContentForChecksum(content))}`
    const vanilla = `${JSON.stringify({ schemaVersion: 1, checksum }, null, 2)}\n`
    const vanillaPacked = packedJson(immutableCatalogSnapshot({ ...content, checksum }))
    const catalogs = []
    const seenProjects = new Set()
    for (const source of manifest.mods) {
      if (seenProjects.has(source.projectId)) continue
      seenProjects.add(source.projectId)
      const packed = JSON.parse(await readFile(join(ROOT, 'src/assets/mod-sources', `${source.sha256}.json`), 'utf8'))
      const bytes = gunzipSync(Buffer.from(packed.data, 'base64'), { maxOutputLength: MAX_SOURCE_BYTES })
      if (bytes.length !== source.sourceBytes || digest(bytes) !== source.sha256) throw new Error(`Bundled source integrity differs: ${source.title}`)
      const preview = await previewCrystalEdit(new Uint8Array(bytes), `${source.title}.json`, GENERATED_AT)
      const catalog = preview.proposed.catalogs[0]
      if (catalog?.id !== `crystal-edit:${source.projectId}`) throw new Error(`Bundled project identity differs: ${source.title}`)
      catalogs.push(modSearchCatalog(catalog))
    }
    const json = JSON.stringify({ schemaVersion: 1, catalogs })
    const index = packedJson({ schemaVersion: 1, catalogs })
    for (const [path, text] of [[INDEX, index], [VANILLA_RECEIPT, vanilla], [VANILLA_PACKED, vanillaPacked]]) {
      if (check) { if (await readFile(join(ROOT, path), 'utf8') !== text) throw new Error(`Generated output differs: ${path}`) }
      else await writeFile(join(ROOT, path), text)
    }
    return { projects: catalogs.length, searchBytes: Buffer.byteLength(json), packedBytes: Buffer.byteLength(index) }
  } finally { await server.close() }
}

async function main() {
  let values
  try { values = parseArgs({ options: { check: { type: 'boolean', short: 'c' }, help: { type: 'boolean', short: 'h' } }, allowPositionals: false }).values }
  catch (error) { process.stderr.write(`${error.message}\n${HELP}`); process.exitCode = 2; return }
  if (values.help) { process.stdout.write(HELP); return }
  try { process.stdout.write(`${JSON.stringify(await generateModIndex(values))}\n`) }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = error.code === 'ERR_MODULE_NOT_FOUND' ? 3 : 1 }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
