#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

const USAGE = `Usage: node scripts/privacy-check.mjs [-s|--staged] [-h|--help]
Check tracked and nonignored application files for private imports, machine paths,
credentials, personal email addresses, and enabled workflow files.
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
  /^\.github\/workflows\//,
]
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
// Match reviewed public font bytes exactly so replacements require another review
const reviewedBinaryAssets = new Map([
  ['src/assets/fonts/pixel-operator.woff2', 'fc5d6a2ee3d73d978200269354e681862e1436c3edd42235f28b87e9ca0b8afe'],
])
for (const file of new Set(files)) {
  if (forbiddenPaths.some(pattern => pattern.test(file))) findings.push(`${file}: prohibited artifact or enabled CI workflow`)
  if (file === 'LICENSE' || file.endsWith('.png') || file.endsWith('.ico')) continue
  let bytes
  try { bytes = options.staged ? git(['show', `:${file}`]) : readFileSync(file) }
  catch { findings.push(`${file}: unable to inspect contents`); continue }
  if (reviewedBinaryAssets.has(file)) {
    if (reviewedBinaryAssets.get(file) !== createHash('sha256').update(bytes).digest('hex')) findings.push(`${file}: public font changed; review bytes and digest`)
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
