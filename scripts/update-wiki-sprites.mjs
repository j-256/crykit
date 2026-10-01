#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { ASSET_FILE_PATTERN, MAX_IMAGE_BYTES, MAX_TOTAL_BYTES, TEMPLATE_TITLES, WIKI_ORIGIN, canonicalEntityIds, downloadedImage, licenseDeclaration, normalize, originalImageUrl, spriteCandidates, validateImage, wikiUrl } from './wiki-sprites.mjs'
import { ICON_TEMPLATE, iconCandidates, validateIconRegion } from './wiki-icons.mjs'
import { validateContentBounds, visibleContentBounds } from './sprite-content-bounds.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CACHE = join(ROOT, '.wiki-cache', 'sprites')
const ASSETS = join(ROOT, 'src', 'assets', 'wiki-sprites')
const MANIFEST = join(ROOT, 'src', 'catalog', 'wiki-sprites.json')
const BATCH_SIZE = 50
const CACHE_SCHEMA = 2
const MANIFEST_SCHEMA = 3
const SOURCE_TEMPLATES = [...TEMPLATE_TITLES, ICON_TEMPLATE]
const USER_AGENT = 'CryKitSprites/0.1 (personal offline fan planner)'
const REQUEST_TIMEOUT_MS = 30_000
const USAGE = `Usage: node scripts/update-wiki-sprites.mjs [-c|--cache] [--check] [-h|--help]
Download original wiki sprites, menu icons, and explicit bindings with attribution.
Requires Node.js 22.12+; no credentials or environment variables are needed.
Reads src/catalog/wiki-data.json and the starter identities in src/catalog/data.ts.
Writes src/assets/wiki-sprites/ and src/catalog/wiki-sprites.json only after downloads
are verified. The ignored .wiki-cache/sprites/ directory retains API and image inputs.
  -c, --cache  Reproduce the snapshot offline from the matching local source cache
      --check  Verify the committed manifest and asset bytes without network or writes
  -h, --help   Show this help
Refresh preserves unknown mappings and missing wiki files in manifest coverage.
Transport errors, unsupported mappings, or changed checksums abort publication.
Results go to stdout; progress and errors go to stderr.
Exit: 0 success/help, 1 runtime or integrity failure, 2 invalid options.
`

function options() {
  try {
    const { values } = parseArgs({ options: { help: { type: 'boolean', short: 'h' }, cache: { type: 'boolean', short: 'c' }, check: { type: 'boolean' } }, strict: true })
    if (values.help) { process.stdout.write(USAGE); process.exit(0) }
    if (values.cache && values.check) throw new Error('--cache and --check are mutually exclusive')
    return values
  } catch (error) { console.error(error.message); process.exit(2) }
}

async function api(parameters) {
  const url = new URL('/api.php', WIKI_ORIGIN)
  url.search = new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', ...parameters })
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`Wiki API HTTP ${response.status}`)
  const payload = await response.json()
  if (payload.error || payload.warnings) throw new Error(`Wiki API: ${JSON.stringify(payload.error ?? payload.warnings)}`)
  return payload
}

async function queryBatches(values, parameter, properties = {}) {
  const pages = []
  for (let index = 0; index < values.length; index += BATCH_SIZE) {
    const payload = await api({ [parameter]: values.slice(index, index + BATCH_SIZE).join('|'), prop: 'revisions', rvprop: 'ids|timestamp|content', rvslots: 'main', ...properties })
    if (payload.continue) throw new Error('Unexpected incomplete wiki batch')
    pages.push(...payload.query.pages)
  }
  return pages
}

function revisionPages(pages) {
  return pages.flatMap(page => (page.revisions ?? []).map(revision => ({ title: page.title, revisionId: revision.revid, revisedAt: revision.timestamp, content: revision.slots?.main?.content ?? '' })))
}

async function fetchSources(entities, wikiContentDigest) {
  const references = entities.filter(entity => ['class', 'monster'].includes(entity.kind)).flatMap(entity => (entity.legacy?.wiki?.pages ?? []).filter(page => normalize(page.title) === normalize(entity.name)))
  const pages = revisionPages(await queryBatches([...new Set(references.map(page => page.revisionId))], 'revids'))
  const templates = revisionPages(await queryBatches(SOURCE_TEMPLATES, 'titles'))
  if (templates.length !== SOURCE_TEMPLATES.length) throw new Error('A required wiki template is missing')
  const { candidates } = spriteCandidates(entities, pages, templates)
  const titles = [...new Set([...candidates, ...iconCandidates(entities, pages, templates)].map(candidate => candidate.title))].sort()
  const files = await queryBatches(titles, 'titles', { prop: 'revisions|imageinfo', iiprop: 'url|size|mime|sha1|timestamp' })
  return { schema: CACHE_SCHEMA, wikiContentDigest, pages, templates, files }
}

async function download(info, useCache, allowPngReencoding) {
  const cachePath = join(CACHE, `${info.sha1}.image`)
  if (!/^[a-f0-9]{40}$/.test(info.sha1)) throw new Error('Invalid wiki image checksum')
  let bytes
  try { bytes = await readFile(cachePath) } catch (error) { if (error.code !== 'ENOENT' || useCache) throw error }
  if (!bytes) {
    if (info.size > MAX_IMAGE_BYTES) throw new Error('Wiki image exceeds the download limit')
    const response = await fetch(originalImageUrl(info.url, info.mime), { redirect: 'error', headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`Image download HTTP ${response.status}`)
    const chunks = []
    let size = 0
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > MAX_IMAGE_BYTES) throw new Error('Image response exceeds the download limit')
      chunks.push(chunk)
    }
    bytes = Buffer.concat(chunks)
    downloadedImage(bytes, info, allowPngReencoding)
    await writeFile(cachePath, bytes)
  }
  return { bytes, ...downloadedImage(bytes, info, allowPngReencoding) }
}

async function checkManifest(wikiContentDigest, entities) {
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'))
  if (manifest.schemaVersion !== MANIFEST_SCHEMA || manifest.wikiContentDigest !== wikiContentDigest) throw new Error('Sprite manifest schema or wiki input digest is stale')
  const checkedFiles = new Set()
  let total = 0
  for (const asset of Object.values(manifest.assets)) {
    if (!ASSET_FILE_PATTERN.test(asset.file)) throw new Error('Invalid local sprite filename')
    const bytes = await readFile(join(ASSETS, asset.file))
    const checked = validateImage(bytes, asset)
    if (checked.file !== asset.file || checked.sha256 !== asset.sha256) throw new Error(`Local sprite digest mismatch: ${asset.title}`)
    if (asset.contentBounds) {
      validateContentBounds(asset.contentBounds, asset)
      const actualBounds = await visibleContentBounds(bytes)
      if (JSON.stringify(actualBounds) !== JSON.stringify(asset.contentBounds)) throw new Error(`Artwork content bounds mismatch: ${asset.title}`)
    }
    originalImageUrl(asset.sourceUrl, asset.mime)
    if (!checkedFiles.has(asset.file)) total += bytes.length
    checkedFiles.add(asset.file)
  }
  if (total > MAX_TOTAL_BYTES) throw new Error('Sprite snapshot exceeds the total size limit')
  const identities = new Map(entities.map(entity => [entity.id, entity]))
  for (const [id, binding] of Object.entries(manifest.entities)) {
    if (!manifest.assets[binding.asset] || !binding.sources.length) throw new Error('Sprite binding has no asset or attribution')
    const entity = identities.get(id)
    if (entity?.kind !== binding.kind || entity?.name !== binding.name) throw new Error(`Sprite binding does not match a catalog identity: ${id}`)
    if (!manifest.assets[binding.asset].contentBounds) throw new Error(`Catalog artwork has no content bounds: ${binding.name}`)
  }
  for (const [id, binding] of Object.entries(manifest.icons)) {
    const asset = manifest.assets[binding.asset]
    if (!asset || !binding.sources.length || !/^(equipment|element|skill|command):.+$/.test(id)) throw new Error('Menu icon has no asset, semantic identity, or attribution')
    validateIconRegion(binding.region, asset)
  }
  console.log(`Verified ${checkedFiles.size} sprite files (${total} bytes), ${Object.keys(manifest.entities).length} catalog bindings, and ${Object.keys(manifest.icons).length} menu icons`)
}

async function main() {
  const flags = options()
  const wiki = JSON.parse(await readFile(join(ROOT, 'src', 'catalog', 'wiki-data.json'), 'utf8'))
  const entities = canonicalEntityIds(wiki.entities, await readFile(join(ROOT, 'src', 'catalog', 'data.ts'), 'utf8'))
  if (flags.check) return checkManifest(wiki.contentDigest, entities)
  await mkdir(CACHE, { recursive: true })
  const cachePath = join(CACHE, 'sources.json')
  console.error(flags.cache ? 'Reading cached sprite sources' : 'Fetching pinned wiki pages, icon templates, and file metadata')
  const source = flags.cache ? JSON.parse(await readFile(cachePath, 'utf8')) : await fetchSources(entities, wiki.contentDigest)
  if (source.schema !== CACHE_SCHEMA || source.wikiContentDigest !== wiki.contentDigest) throw new Error('Sprite source cache is stale; refresh without --cache')
  if (!flags.cache) await writeFile(cachePath, `${JSON.stringify(source, null, 2)}\n`)
  const { candidates, unmatched } = spriteCandidates(entities, source.pages, source.templates)
  const files = new Map(source.files.map(file => [normalize(file.title), file]))
  const icons = iconCandidates(entities, source.pages, source.templates)
  const manifest = { schemaVersion: MANIFEST_SCHEMA, wikiContentDigest: wiki.contentDigest, assets: {}, entities: {}, icons: {}, coverage: { unmatched, missingFiles: [] } }
  const outputs = new Map()
  let total = 0
  for (const candidate of [...candidates, ...icons]) {
    const page = files.get(normalize(candidate.title))
    const info = page?.imageinfo?.[0]
    if (!info) {
      manifest.coverage.missingFiles.push({ id: candidate.id, title: candidate.title, sources: candidate.sources })
      continue
    }
    let downloaded
    try { downloaded = await download(info, flags.cache, !candidate.kind) } catch (error) { throw new Error(`${page.title}: ${error.message}`, { cause: error }) }
    const { bytes, file, sha256, metadata } = downloaded
    if (!outputs.has(file)) total += bytes.length
    if (total > MAX_TOTAL_BYTES) throw new Error('Sprite snapshot exceeds the total size limit')
    outputs.set(file, bytes)
    const revision = page.revisions?.[0]
    if (!revision?.revid) throw new Error(`File description revision is missing: ${page.title}`)
    const assetKey = normalize(page.title)
    const contentBounds = candidate.kind ? await visibleContentBounds(bytes) : manifest.assets[assetKey]?.contentBounds
    manifest.assets[assetKey] = {
      file, sha256, title: page.title, sourceUrl: originalImageUrl(info.url, info.mime), descriptionUrl: wikiUrl(page.title, revision.revid),
      descriptionRevisionId: revision.revid, uploadedAt: info.timestamp, sha1: metadata.sha1, mime: info.mime, width: info.width, height: info.height, size: metadata.size,
      ...(metadata.representation ? { representation: metadata.representation, originalSha1: metadata.originalSha1, originalSize: metadata.originalSize } : {}),
      ...(contentBounds ? { contentBounds } : {}),
      license: licenseDeclaration(revision.slots?.main?.content ?? ''),
    }
    if (candidate.kind) manifest.entities[candidate.id] = { kind: candidate.kind, name: candidate.name, asset: assetKey, sources: candidate.sources }
    else {
      validateIconRegion(candidate.region, info)
      manifest.icons[candidate.id] = { name: candidate.name, asset: assetKey, sources: candidate.sources.length ? candidate.sources : [{ title: page.title, revisionId: revision.revid, url: wikiUrl(page.title, revision.revid), locator: candidate.region ? 'Equipment menu glyph region' : 'Named weapon glyph' }], ...(candidate.region ? { region: candidate.region } : {}) }
    }
    const completed = Object.keys(manifest.entities).length + Object.keys(manifest.icons).length
    if (completed % BATCH_SIZE === 0) console.error(`Verified ${completed}/${candidates.length + icons.length} sprite bindings`)
  }
  await mkdir(ASSETS, { recursive: true })
  for (const [file, bytes] of outputs) await writeFile(join(ASSETS, file), bytes)
  const temporaryManifest = join(CACHE, 'manifest.json')
  await writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`)
  await rename(temporaryManifest, MANIFEST)
  console.log(`Saved ${outputs.size} verified sprite files (${total} bytes) for ${Object.keys(manifest.entities).length} definitions and ${Object.keys(manifest.icons).length} menu icons; ${unmatched.length} unmapped definitions, ${manifest.coverage.missingFiles.length} missing wiki files`)
}

try { await main() } catch (error) { console.error(error.message); process.exitCode = 1 }
