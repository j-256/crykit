#!/usr/bin/env node
import { readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { GAME_IDENTITY_MANIFEST_SCHEMA, hash } from './game-assets.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const MANIFEST = join(ROOT, 'src/catalog/game-identities.json')
const NATIVE = join(ROOT, 'src/catalog/native-game-data.json')
const USAGE = `Usage: node scripts/update-game-identities.mjs [--check] [-h|--help]
Project explicit numeric identity bindings from bundled native-game-data.json.
Source executable and database fingerprints are retained; labels are read only
from the bound native records. No name matching or secondary catalogs are used.
Requires Node.js and the committed native snapshot, with no environment variables.
      --check  Verify the committed projection offline without writes
  -h, --help   Show help
Results go to stdout; errors go to stderr.
Exit: 0 success/help, 1 integrity/read failure, 2 invalid options.
`

export function buildGameIdentityManifest(snapshot) {
  const mappings = {}
  const files = new Map(snapshot.source.files.map(file => [file.path, file]))
  for (const [key, entityId] of Object.entries(snapshot.identityBindings)) {
    const match = /^([a-z]+):(\d+)$/.exec(key)
    const database = match?.[1]
    const databaseId = Number(match?.[2])
    const record = snapshot.databases[database]?.find(record => record?.ID === databaseId)
    const file = files.get(`Database/${database}.dat`)
    if (!match || !record || !/^[a-f0-9]{64}$/.test(file?.sha256 ?? '') || typeof entityId !== 'string' || mappings[entityId]) throw new Error(`Invalid explicit native identity: ${key}`)
    const kind = database === 'job' ? 'class' : ['item', 'equipment'].includes(database) ? 'item' : database === 'passive' ? record.IsInnate ? 'innate' : 'passive' : database === 'ability' ? record.IsSightLearned ? 'monsterMagic' : 'ability' : database
    mappings[entityId] = { kind, name: record.Name, sourceKey: 'native-game-data', database, databaseId, databaseSha256: file.sha256, locator: `Database/${database}.dat record ${databaseId}` }
  }
  // Pin original game inputs rather than the snapshot digest, which includes this projection's historical receipt
  const source = { platform: snapshot.source.platform, gameVersion: snapshot.source.gameVersion, executableSha256: snapshot.source.executable.sha256, files: snapshot.source.files.filter(file => Object.values(mappings).some(mapping => file.path === `Database/${mapping.database}.dat`)).map(({ path, sha256 }) => ({ path, sha256 })) }
  return { schemaVersion: GAME_IDENTITY_MANIFEST_SCHEMA, source: { ...source, contentDigest: hash(JSON.stringify(source)) }, mappings, unresolved: [] }
}

async function main() {
  let values
  try {
    values = parseArgs({ options: { help: { type: 'boolean', short: 'h' }, check: { type: 'boolean' } }, strict: true }).values
    if (values.help) { process.stdout.write(USAGE); return }
  } catch (error) { console.error(error.message); process.exitCode = 2; return }
  const snapshot = JSON.parse(await readFile(NATIVE, 'utf8'))
  const manifest = buildGameIdentityManifest(snapshot)
  if (values.check) {
    if (JSON.stringify(JSON.parse(await readFile(MANIFEST, 'utf8'))) !== JSON.stringify(manifest)) throw new Error('Native identity projection differs from the fingerprinted native snapshot; regenerate it')
    console.log('Verified native identity bindings and original game fingerprints')
  } else {
    await writeFile(`${MANIFEST}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`)
    await rename(`${MANIFEST}.tmp`, MANIFEST)
    console.log('Saved native identity bindings with original game fingerprints')
  }
}

if (process.argv[1] && await realpath(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1 })
