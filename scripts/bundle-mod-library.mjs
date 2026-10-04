#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { gzipSync, gunzipSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'

const MAX_SOURCE_BYTES = 96 * 1024 * 1024
const MAX_SOURCE_NODES = 3_000_000
const MAX_SOURCE_DEPTH = 64
const MODEL_FAMILIES = ['Jobs', 'Abilities', 'Passives', 'Equipment', 'Items', 'Monsters', 'Statuses', 'Recipes', 'Biomes', 'Genders']
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const DEFAULT_OUTPUT = 'src/assets/mod-sources'
const DEFAULT_MANIFEST = 'src/catalog/bundled-mod-sources.json'
const HELP = `Usage: node scripts/bundle-mod-library.mjs -i DIRECTORY [-o DIRECTORY] [-m FILE]
       node scripts/bundle-mod-library.mjs -c [-o DIRECTORY] [-m FILE]

Bundle every Crystal Edit mod JSON in a directory and its subdirectories.
Exact UTF-8 sources are compressed into immutable, digest-named JSON assets.
The generated manifest contains project IDs, versions, model IDs, and source
digests. Identical files are deduplicated; distinct revisions remain separate.
Previously bundled revisions are retained when refreshing the directory.
Non-mod JSON and symlinks are skipped. Invalid JSON or private content fails
before writing. No mod code is executed, no sources are changed, and no network
or environment variables are used. Requires Node >=22.12.
  -i, --input-directory DIR  Directory containing mod JSON exports
  -o, --output-directory DIR Generated assets (default: ${DEFAULT_OUTPUT})
  -m, --manifest FILE        Generated manifest (default: ${DEFAULT_MANIFEST})
  -c, --check                Verify committed sources without the input directory
  -h, --help                 Show help
Results use stdout; diagnostics use stderr. Exit: 0 success/help, 1 read,
integrity or content failure, 2 invalid options or missing input directory.
`
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const jsonText = value => `${JSON.stringify(value, null, 2)}\n`

function assertPublicSource(text) {
  // Game vocabulary and actor-name tokens resemble email addresses
  const prose = text.replace(/@V\.[A-Za-z0-9_]+|@C@[A-Za-z0-9_]+\.Name\b|@[IZ]\d+\.Name\b|@X\.SITempNumber\b/g, ' ')
  const patterns = [
    ['machine path', /\/Users\/|[A-Za-z]:[\\/](?:Users|Documents|Desktop|Downloads)[\\/]/],
    ['personal scratch path', /(?:^|[\s"'`(])\/(?:w|c|z)\//m],
    ['credential', /\b(?:gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{25,}|AKIA[A-Z0-9]{16})\b/],
    ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ['email address', /\b[A-Z0-9._%+-]+@(?!example\.(?:com|org|net)\b|users\.noreply\.github\.com\b)[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
  ]
  for (const [label, pattern] of patterns) if (pattern.test(prose)) throw new Error(`Mod source contains a ${label}`)
}

export function inspectModSource(bytes) {
  if (!bytes.length || bytes.length > MAX_SOURCE_BYTES) throw new Error('Mod source exceeds the bounded source size')
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  const root = JSON.parse(text.replace(/^\uFEFF/, ''))
  if (!root || Array.isArray(root) || typeof root !== 'object' || !('ID' in root) || !('EditorVersion' in root)) return undefined
  if (typeof root.ID !== 'string' || !root.ID.trim() || root.ID.length > 512 || /[\u0000-\u001f\u007f]/.test(root.ID) || typeof root.Title !== 'string' || !root.Title.trim() || root.Title.length > 512 || !Number.isSafeInteger(root.EditorVersion) || root.EditorVersion < 0) throw new Error('Invalid Crystal Edit project identity')
  let nodes = 0
  const visit = (value, depth) => {
    if (++nodes > MAX_SOURCE_NODES || depth > MAX_SOURCE_DEPTH) throw new Error('Mod source exceeds bounded JSON complexity')
    if (typeof value === 'string') assertPublicSource(value)
    if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) throw new Error('Unsafe source object key')
      assertPublicSource(key)
      visit(entry, depth + 1)
    }
  }
  visit(root, 0)
  const models = {}
  for (const family of MODEL_FAMILIES) {
    const records = root[family]
    if (records === undefined) continue
    if (!Array.isArray(records)) throw new Error(`${family} must be a model array`)
    const ids = new Set()
    for (const record of records) {
      if (!record || !Number.isSafeInteger(record.ID) || record.ID < 0 || record.ID > 0xffffffff || typeof record.Name !== 'string' || !record.Name.trim() || ids.has(record.ID)) throw new Error(`Invalid or duplicate ${family} identity`)
      ids.add(record.ID)
    }
    models[family] = [...ids]
  }
  const workshop = typeof root.SteamWorkshopFileID === 'string' ? root.SteamWorkshopFileID : Number.isSafeInteger(root.SteamWorkshopFileID) ? String(root.SteamWorkshopFileID) : ''
  return { projectId: root.ID, title: root.Title, ...(typeof root.Version === 'string' ? { version: root.Version } : {}), editorVersion: root.EditorVersion, ...(typeof root.Timestamp === 'string' ? { timestamp: root.Timestamp } : {}), ...(/^[1-9]\d{0,19}$/.test(workshop) ? { steamWorkshopFileId: workshop } : {}), sha256: digest(bytes), sourceBytes: bytes.length, models }
}

async function sourceFiles(directory) {
  const files = []
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await sourceFiles(path))
    else if (entry.isFile() && /\.json$/i.test(entry.name)) files.push(path)
  }
  return files
}

export async function bundleModDirectory(input, output, manifestPath) {
  const snapshots = new Map()
  let skipped = 0
  let duplicates = 0
  for (const path of await sourceFiles(input)) {
    const bytes = await readFile(path)
    let source
    try { source = inspectModSource(bytes) } catch (error) { throw new Error(`${basename(path)}: ${error.message}`) }
    if (!source) { skipped++; continue }
    if (snapshots.has(source.sha256)) { duplicates++; continue }
    snapshots.set(source.sha256, { source, bytes })
  }
  if (!snapshots.size) throw new Error('The input directory contains no Crystal Edit mod JSON')
  let retained = []
  try { retained = JSON.parse(await readFile(manifestPath, 'utf8')).mods }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  if (retained.length) await checkModLibrary(output, manifestPath)
  const revisions = new Map(retained.map(source => [source.sha256, source]))
  for (const { source } of snapshots.values()) revisions.set(source.sha256, source)
  const mods = [...revisions.values()].sort((left, right) => left.projectId.localeCompare(right.projectId) || (right.timestamp ?? '').localeCompare(left.timestamp ?? '') || left.sha256.localeCompare(right.sha256))
  const generated = [...snapshots.values()].map(({ source, bytes }) => ({ path: join(output, `${source.sha256}.json`), text: jsonText({ schemaVersion: 1, encoding: 'gzip-base64', sha256: source.sha256, sourceBytes: bytes.length, data: gzipSync(bytes, { level: 9 }).toString('base64') }) }))
  for (const file of generated) {
    try { if (await readFile(file.path, 'utf8') !== file.text) throw new Error('Immutable source asset differs') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  await mkdir(output, { recursive: true })
  for (const file of generated) {
    try { await writeFile(file.path, file.text, { flag: 'wx' }) } catch (error) { if (error.code !== 'EEXIST') throw error }
  }
  await mkdir(resolve(manifestPath, '..'), { recursive: true })
  await writeFile(manifestPath, jsonText({ schemaVersion: 1, mods }))
  return { mods: mods.length, skipped, duplicates }
}

export async function checkModLibrary(output, manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.mods) || !manifest.mods.length) throw new Error('Invalid bundled mod manifest')
  const seen = new Set()
  for (const source of manifest.mods) {
    if (!/^[a-f0-9]{64}$/.test(source.sha256) || seen.has(source.sha256)) throw new Error('Invalid or duplicate source digest')
    seen.add(source.sha256)
    const asset = JSON.parse(await readFile(join(output, `${source.sha256}.json`), 'utf8'))
    if (asset.schemaVersion !== 1 || asset.encoding !== 'gzip-base64' || asset.sha256 !== source.sha256 || asset.sourceBytes !== source.sourceBytes || asset.sourceBytes > MAX_SOURCE_BYTES || typeof asset.data !== 'string') throw new Error('Invalid bundled source asset')
    const bytes = gunzipSync(Buffer.from(asset.data, 'base64'), { maxOutputLength: MAX_SOURCE_BYTES })
    if (bytes.length !== source.sourceBytes || JSON.stringify(inspectModSource(bytes)) !== JSON.stringify(source)) throw new Error('Bundled source evidence differs from the manifest')
  }
  const assets = (await readdir(output)).filter(file => file.endsWith('.json'))
  if (assets.some(file => !seen.has(file.replace(/\.json$/, '')))) throw new Error('Unlisted bundled mod source asset')
  return { mods: seen.size }
}

async function main() {
  let values
  try {
    values = parseArgs({ options: { 'input-directory': { type: 'string', short: 'i' }, 'output-directory': { type: 'string', short: 'o' }, manifest: { type: 'string', short: 'm' }, check: { type: 'boolean', short: 'c' }, help: { type: 'boolean', short: 'h' } }, strict: true }).values
    if (values.help) { process.stdout.write(HELP); return }
    if (Object.values(values).some(value => value === '') || values.check && values['input-directory'] || !values.check && !values['input-directory']) throw new Error('Choose an input directory or --check')
  } catch (error) { process.stderr.write(`${error.message}\n${HELP}`); process.exitCode = 2; return }
  try {
    const output = values['output-directory'] ?? DEFAULT_OUTPUT
    const manifest = values.manifest ?? DEFAULT_MANIFEST
    const result = values.check ? await checkModLibrary(output, manifest) : await bundleModDirectory(values['input-directory'], output, manifest)
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
