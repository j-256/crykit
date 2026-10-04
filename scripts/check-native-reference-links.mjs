#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const HELP = `Usage: node scripts/check-native-reference-links.mjs [-c|--check] [-h|--help]
Check reviewed native reference links, complete residual dispositions, exact
catalog content, native fingerprints, and source/target evidence offline.
Requires Node >=22.12 and installed project dependencies. No environment
variables, private files, network requests, or writes are used. Results use
stdout; diagnostics use stderr. Exit: 0 success/help, 1 integrity failure,
2 usage, 3 missing dependency. --check is the default and never edits a link.
`
let flags
try { flags = parseArgs({ options: { check: { type: 'boolean', short: 'c' }, help: { type: 'boolean', short: 'h' } }, allowPositionals: false }).values }
catch (error) { console.error(error.message); process.exit(2) }
if (flags.help) { process.stdout.write(HELP); process.exit(0) }
let createServer
try { ({ createServer } = await import('vite')) }
catch (error) { console.error(`Vite is required: ${error.message}`); process.exit(3) }
let server
try {
  server = await createServer({ root: ROOT, configFile: false, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
  const { BUNDLED_CATALOG: catalog } = await server.ssrLoadModule('/src/catalog/bundled.ts')
  const { catalogContentForChecksum } = await server.ssrLoadModule('/src/interchange/catalog-checksum.ts')
  const { NATIVE_REFERENCE_LINKS: manifest, validateNativeReferenceLinks } = await server.ssrLoadModule('/src/catalog/native-reference-links.ts')
  const { checksum, ...content } = catalog
  if (checksum !== `builtin:sha256:${createHash('sha256').update(catalogContentForChecksum(content)).digest('hex')}`) throw new Error('Native reference catalog content does not match its checksum')
  validateNativeReferenceLinks(manifest)
  console.log(`Verified ${manifest.links.length} reviewed native reference links and ${manifest.dispositions.length} residual dispositions`)
} catch (error) { console.error(error.message); process.exitCode = 1 }
finally { await server?.close() }
