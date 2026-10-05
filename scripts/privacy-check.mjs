#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

const USAGE = `Usage: node scripts/privacy-check.mjs [-s|--staged] [-h|--help]
Check tracked and nonignored application files for private imports, machine paths,
credentials, personal email addresses, and unreviewed workflow files.
--staged checks only the staged versions of added or modified files.
Requires Node.js and Git. Exit: 0 clean/help, 1 findings/read failure, 2 usage,
3 missing Git. No files are changed and no network requests are made.
`

let options
try {
  options = parseArgs({ options: { help: { type: 'boolean', short: 'h' }, staged: { type: 'boolean', short: 's' } }, strict: true }).values
} catch (error) {
  console.error(error.message)
  process.exit(2)
}
if (options.help) { process.stdout.write(USAGE); process.exit(0) }

const forbiddenPaths = [
  /(^|\/)(private|imports|backups|node_modules|\.env)(\/|$|\.)/i,
  /(^|\/)crystal_project_.*\.(md|html|json|xlsx|zip)$/i,
  /\.(xlsx|zip|sqlite|db|pem|key)$/i,
]
const reviewedWorkflows = new Set(['.github/workflows/deploy.yml'])
const machineRoot = '/' + 'Users' + '/'
const scratchRoots = ['w', 'c', 'z'].map(name => '/' + name + '/')
const forbiddenContent = [
  { label: 'machine-local path', pattern: new RegExp(machineRoot.replaceAll('/', '\\/')) },
  { label: 'personal scratch path', pattern: new RegExp(`(?:^|[\\s"'\x60(])(?:${scratchRoots.join('|')})`, 'm') },
  { label: 'credential', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{25,}|AKIA[A-Z0-9]{16})\b/ },
  { label: 'private key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { label: 'personal email', pattern: /\b[A-Z0-9._%+-]+@(?!example\.(?:com|org|net)\b|users\.noreply\.github\.com\b)[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
]

function git(args) {
  try { return execFileSync('git', args, { maxBuffer: 32 * 1024 * 1024 }) }
  catch (error) {
    console.error(error.code === 'ENOENT' ? 'Git is required.' : 'Unable to read the Git file set.')
    process.exit(error.code === 'ENOENT' ? 3 : 1)
  }
}

const deletedFiles = new Set(options.staged ? [] : git(['ls-files', '--deleted', '-z']).toString().split('\0'))
const files = git(options.staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'] : ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).toString().split('\0').filter(file => file && !deletedFiles.has(file))
const findings = []
// Match reviewed public asset bytes exactly so replacements require another review
const reviewedBinaryAssets = new Map([
  ['src/assets/fonts/pixel-operator.woff2', 'fc5d6a2ee3d73d978200269354e681862e1436c3edd42235f28b87e9ca0b8afe'],
  ['src/assets/ratings/job-rating.png', 'f5ee30139e40d1aa05677754d1bc01354703676ffcf33f6a413fe330f3321d14'],
  ['src/assets/menu-icons/equipment-types.png', '0e2066d5776e5a23d9fb4f9291a7d8a07f22f7353ec352882fb30af2fb20ee9e'],
])
const gameAssetDirectory = 'src/assets/game-assets/'
const gameAssetManifestPath = 'src/catalog/game-assets.json'
const spriteSources = [
  { directory: 'src/assets/mod-artwork-atlases/', manifestPath: 'src/catalog/mod-artwork.json', assetField: 'atlases', label: 'Mod artwork atlas manifest' },
  { directory: 'src/assets/mod-artwork/', manifestPath: 'src/catalog/mod-artwork.json', label: 'Mod artwork manifest' },
  { directory: 'src/assets/wiki-sprites/', manifestPath: 'src/catalog/wiki-sprites.json', label: 'Wiki sprite manifest' },
  { directory: 'src/assets/mod-sprites/', manifestPath: 'src/catalog/mod-sprites.json', label: 'Mod sprite manifest' },
]
for (const source of spriteSources) try {
  const manifest = JSON.parse((options.staged ? git(['show', `:${source.manifestPath}`]) : readFileSync(source.manifestPath)).toString('utf8'))
  for (const asset of Object.values(manifest[source.assetField ?? 'assets'])) {
    if (!/^[a-f0-9]{64}\.(?:png|gif|webp)$/.test(asset.file) || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('Invalid sprite manifest entry')
    reviewedBinaryAssets.set(`${source.directory}${asset.file}`, asset.sha256)
  }
} catch { findings.push(`${source.label}: unable to read reviewed asset hashes`) }
try {
  const manifest = JSON.parse((options.staged ? git(['show', `:${gameAssetManifestPath}`]) : readFileSync(gameAssetManifestPath)).toString('utf8'))
  for (const asset of Object.values(manifest.assets)) {
    if (!/^[a-f0-9]{64}\.png$/.test(asset.file) || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('Invalid native game artwork manifest entry')
    reviewedBinaryAssets.set(`${gameAssetDirectory}${asset.file}`, asset.sha256)
  }
} catch { findings.push('Native game artwork manifest: unable to read reviewed asset hashes') }
for (const file of new Set(files)) {
  if (forbiddenPaths.some(pattern => pattern.test(file))) findings.push(`${file}: prohibited artifact`)
  if (file.startsWith('.github/workflows/') && !reviewedWorkflows.has(file)) findings.push(`${file}: unreviewed CI workflow`)
  const spriteDirectory = spriteSources.some(source => file.startsWith(source.directory))
  if (spriteDirectory && !reviewedBinaryAssets.has(file)) findings.push(`${file}: sprite is absent from the reviewed manifest`)
  if (file.startsWith(gameAssetDirectory) && !reviewedBinaryAssets.has(file)) findings.push(`${file}: native game artwork is absent from the reviewed manifest`)
  if (!reviewedBinaryAssets.has(file) && !spriteDirectory && !file.startsWith(gameAssetDirectory) && (file === 'LICENSE' || file.endsWith('.png') || file.endsWith('.ico'))) continue
  let bytes
  try { bytes = options.staged ? git(['show', `:${file}`]) : readFileSync(file) }
  catch { findings.push(`${file}: unable to inspect contents`); continue }
  if (reviewedBinaryAssets.has(file)) {
    if (reviewedBinaryAssets.get(file) !== createHash('sha256').update(bytes).digest('hex')) findings.push(`${file}: public asset changed; review bytes and digest`)
    continue
  }
  if (bytes.includes(0)) { findings.push(`${file}: unreviewed binary content`); continue }
  const contents = bytes.toString('utf8')
  for (const { label, pattern } of forbiddenContent) {
    if (pattern.test(contents)) findings.push(`${file}: ${label}`)
  }
}
if (findings.length) {
  console.error(findings.join('\n'))
  process.exit(1)
}
console.log('Privacy check passed: no prohibited artifacts or content patterns found.')
