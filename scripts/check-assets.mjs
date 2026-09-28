#!/usr/bin/env node
import { readdir, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const MAX_FILES = 20_000
const MAX_FILE_BYTES = 25 * 1024 * 1024
const USAGE = `Usage: node scripts/check-assets.mjs [-h|--help]
Validate the dist directory against Workers Free static asset limits.
Requires Node.js and a production build from npm run build. No credentials,
network requests, or writes. Reports file count, bytes, and largest file as JSON.
Exit: 0 valid/help, 1 filesystem or limit failure, 2 invalid arguments.
`

try {
  const { values } = parseArgs({ options: { help: { type: 'boolean', short: 'h' } }, strict: true })
  if (values.help) { process.stdout.write(USAGE); process.exit(0) }
} catch (error) { console.error(error.message); process.exit(2) }

let files = 0
let bytes = 0
let largest = { path: '', bytes: 0 }
async function inspect(directory) {
  for (const name of await readdir(directory)) {
    const path = join(directory, name)
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new Error(`Static assets must not contain symlinks: ${path}`)
    if (info.isDirectory()) { await inspect(path); continue }
    if (!info.isFile()) throw new Error(`Unsupported asset type: ${path}`)
    files++
    bytes += info.size
    if (info.size > largest.bytes) largest = { path, bytes: info.size }
    if (info.size > MAX_FILE_BYTES) throw new Error(`Asset exceeds the ${MAX_FILE_BYTES}-byte Free limit: ${path}`)
    if (files > MAX_FILES) throw new Error(`Asset count exceeds the ${MAX_FILES}-file Free limit`)
  }
}

try {
  await inspect('dist')
  if (!files) throw new Error('The dist directory contains no assets')
  console.log(JSON.stringify({ files, bytes, largest, limits: { files: MAX_FILES, fileBytes: MAX_FILE_BYTES } }))
} catch (error) { console.error(error.message); process.exit(1) }
