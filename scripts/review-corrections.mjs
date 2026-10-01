#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { readFile, writeFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const help = `Review exported Crystal Kit corrections without uploading any data.

Usage: npm run corrections:review -- [options] FILE

  -h, --help             Show this help
  -p, --promote          Produce a new reviewed catalog bundle after human review
  -r, --revision ID      New immutable catalog revision ID (required with --promote)
  -o, --output FILE      Write the new bundle to a new file (required with --promote)

FILE must be a crykit-corrections version 1 JSON export.
Report mode writes the decision review as JSON to stdout. Promotion requires
confirmed decisions, evidence, applicability, unchanged sources, and resolved
supersession. The maintainer must verify those claims before using --promote.
The output preserves the source catalog revisions and their original claims.
Review the bundle before installing it as src/catalog/reviewed-catalogs.json.
Requires Node.js >=22.12 and this project's npm ci dependencies; no environment
variables or network access are required. Existing output files are never replaced.

Exit codes: 0 success, 1 runtime failure, 2 usage or review precondition error,
3 missing dependencies. Diagnostics go to stderr; review results go to stdout.
`

let parsed
try {
  parsed = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, promote: { type: 'boolean', short: 'p' },
    revision: { type: 'string', short: 'r' }, output: { type: 'string', short: 'o' },
  } })
} catch (error) { console.error(error.message); process.exit(2) }
if (parsed.values.help) { console.log(help); process.exit(0) }
const { values, positionals } = parsed
if (positionals.length !== 1 || (values.promote ? !values.revision?.trim() || !values.output?.trim() : values.revision !== undefined || values.output !== undefined)) {
  console.error('Supply one corrections file. Promotion also requires --revision and --output. Use --help for details.')
  process.exit(2)
}
let createServer
try { ({ createServer } = await import('vite')) } catch { console.error('Missing local Vite dependency. Run npm ci first.'); process.exit(3) }
const root = fileURLToPath(new URL('..', import.meta.url))
let server
try {
  server = await createServer({ root, configFile: false, server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' })
  const [interchange, domain, promotion, bundled] = await Promise.all([
    server.ssrLoadModule('/src/interchange/corrections.ts'),
    server.ssrLoadModule('/src/domain/corrections.ts'),
    server.ssrLoadModule('/src/interchange/correction-promotion.ts'),
    server.ssrLoadModule('/src/catalog/bundled.ts'),
  ])
  if ((await stat(positionals[0])).size > domain.MAX_CORRECTION_BYTES) { console.error('Corrections exceed the 4 MiB limit.'); process.exitCode = 2 }
  else {
    const entries = interchange.readCorrections(await readFile(positionals[0]))
    const active = domain.activeCorrections(entries).filter(entry => entry.changes.length)
    const report = active.map(entry => ({ ...entry, status: domain.correctionStatus(entry, bundled.BUNDLED_CATALOGS, entries), reviewIssues: domain.correctionReviewIssues(entry, bundled.BUNDLED_CATALOGS, entries) }))
    console.log(JSON.stringify({ corrections: report }, null, 2))
    if (values.promote) {
      if (!active.length || active.some(entry => domain.correctionReviewIssues(entry, [bundled.DEFAULT_CATALOG], entries).length) || bundled.BUNDLED_CATALOGS.some(catalog => catalog.id === bundled.DEFAULT_CATALOG.id && catalog.revisionId === values.revision)) {
        console.error('Resolve review issues against the current bundled revision and choose an unused revision ID before promotion.')
        process.exitCode = 2
      } else {
        const catalog = await promotion.promoteCorrections(bundled.DEFAULT_CATALOG, entries, values.revision, new Date().toISOString())
        const result = promotion.validateReviewedCatalogBundle({ format: 'crykit-reviewed-catalogs', version: 1, current: { catalogId: catalog.id, revisionId: catalog.revisionId }, catalogs: [...bundled.BUNDLED_CATALOGS, catalog] })
        await promotion.verifyReviewedCatalogChecksums(result)
        await writeFile(values.output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
        console.error('Reviewed catalog bundle created. Source revisions remain unchanged.')
      }
    }
  }
} catch (error) {
  console.error(`Corrections review failed: ${error.userMessage ?? error.message}`)
  process.exitCode = ['schema-mismatch', 'invalid-json', 'unsupported-format'].includes(error.code) ? 2 : 1
} finally { await server?.close() }
