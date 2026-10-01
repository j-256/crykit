#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'

const FAMILIES = ['Jobs', 'Abilities', 'Passives', 'Equipment', 'Items', 'Monsters', 'Statuses', 'Recipes', 'Biomes', 'Sparks', 'Troops']
const MAX_RECORDS = 20_000
const MAX_BYTES = 32 * 1024 * 1024
const USAGE = `Usage: node scripts/bundle-mod.mjs -i|--input FILE -o|--output FILE -k|--key KEY -m|--mod NAME
       node scripts/bundle-mod.mjs -c|--check -o|--output FILE
Bundle a Crystal Edit JSON export as an offline reference snapshot. KEY is a
lowercase slug; NAME is the named mod setting. FILE output must be a new file:
different source bytes require a new snapshot and catalog revision. Supported
model families retain numeric IDs and values; author comments, local paths,
project folders, and executable content are excluded. No source code is executed.
  -i, --input FILE   Crystal Edit project JSON with ID, Title, Version, EditorVersion
  -o, --output FILE  Normalized snapshot JSON
  -k, --key KEY      Source namespace, such as moonlight-project
  -m, --mod NAME     Required mod setting name
  -c, --check        Validate a committed snapshot without installation or writes
  -h, --help         Show help
Requires Node >=22.12. No environment variables or network access are used.
Results use stdout; errors use stderr. Exit: 0 success/help, 1 integrity/read
failure, 2 invalid options or values.
`
const hash = value => createHash('sha256').update(value).digest('hex')

function clean(value) {
  if (Array.isArray(value)) return value.map(clean)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'Comments').map(([key, entry]) => {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Unsafe source object key')
    return [key, clean(entry)]
  }))
  return value
}

export function validateModSnapshot(snapshot) {
  if (snapshot.schemaVersion !== 1 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(snapshot.key) || typeof snapshot.requiredMod !== 'string' || !snapshot.requiredMod.trim()) throw new Error('Invalid mod snapshot identity')
  const source = snapshot.source
  if (!source || !['projectId', 'title', 'version', 'sha256'].every(key => typeof source[key] === 'string' && source[key]) || !/^[a-f0-9]{64}$/.test(source.sha256) || !Number.isSafeInteger(source.editorVersion)) throw new Error('Invalid mod source evidence')
  let total = 0
  for (const [family, records] of Object.entries(snapshot.families)) {
    if (!FAMILIES.includes(family) || !Array.isArray(records)) throw new Error('Unsupported mod model family')
    const ids = new Set()
    for (const record of records) {
      if (++total > MAX_RECORDS || !record || !Number.isSafeInteger(record.ID) || record.ID < 0 || typeof record.Name !== 'string' || !record.Name.trim() || ids.has(record.ID)) throw new Error(`Invalid or duplicate ${family} identity`)
      ids.add(record.ID)
    }
  }
  if (!total) throw new Error('The mod snapshot contains no reference records')
  const { contentDigest, ...content } = snapshot
  if (contentDigest !== hash(JSON.stringify(content))) throw new Error('Mod snapshot content digest is stale')
  const serialized = JSON.stringify(snapshot)
  if (serialized !== JSON.stringify(clean(snapshot)) || /(?:\/Users\/|[A-Z]:\\\\|\u2014|[\u2018\u2019\u201c\u201d])/.test(serialized)) throw new Error('Mod snapshot contains private paths, comments, or unsupported prose characters')
}

export function normalizeModExport(root, bytes, key, requiredMod) {
  const content = {
    schemaVersion: 1, key, requiredMod,
    source: { projectId: root.ID, title: root.Title, version: root.Version, editorVersion: root.EditorVersion, author: typeof root.Author === 'string' ? root.Author : null, timestamp: typeof root.Timestamp === 'string' ? root.Timestamp : null, sha256: hash(bytes), steamWorkshopFileId: root.SteamWorkshopFileID == null ? null : String(root.SteamWorkshopFileID) },
    families: Object.fromEntries(FAMILIES.filter(family => root[family] !== undefined).map(family => [family, clean(root[family])])),
  }
  const snapshot = { ...content, contentDigest: hash(JSON.stringify(content)) }
  validateModSnapshot(snapshot)
  return snapshot
}

export async function main(args) {
  let values
  try {
    values = parseArgs({ args, options: { input: { type: 'string', short: 'i' }, output: { type: 'string', short: 'o' }, key: { type: 'string', short: 'k' }, mod: { type: 'string', short: 'm' }, check: { type: 'boolean', short: 'c' }, help: { type: 'boolean', short: 'h' } }, allowPositionals: false }).values
    if (values.help) { process.stdout.write(USAGE); return 0 }
    if (!values.output?.trim() || (values.check ? values.input !== undefined || values.key !== undefined || values.mod !== undefined : !values.input?.trim() || !values.mod?.trim() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(values.key ?? ''))) throw new Error('Supply --output and either --check or --input, --key, and --mod')
  } catch (error) { console.error(error.message); return 2 }
  try {
    if (values.check) {
      validateModSnapshot(JSON.parse(await readFile(values.output, 'utf8')))
      console.log('Verified bundled mod identities, source evidence, and content digest')
    } else {
      const bytes = await readFile(values.input)
      if (bytes.length > MAX_BYTES) throw new Error('Mod export exceeds the source size limit')
      const snapshot = normalizeModExport(JSON.parse(bytes.toString('utf8')), bytes, values.key, values.mod)
      await writeFile(values.output, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx' })
      console.log(`Bundled ${snapshot.source.title} ${snapshot.source.version} as ${snapshot.key}`)
    }
    return 0
  } catch (error) { console.error(error.message); return 1 }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2))
