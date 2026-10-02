#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { checkPushVerification } from './integration-verification.mjs'

const USAGE = `Usage: node scripts/check-push-verification.mjs [-h|--help]
Read Git pre-push ref updates from stdin: local-ref local-oid remote-ref remote-oid.
Each object ID is a full SHA-1 or SHA-256 ID; all-zero local IDs mean deletion.
Require successful npm run verify records for every published tree and a clean
checkout. Records are shared by linked worktrees in this repository.
Requires Node.js and Git. XDG_CACHE_HOME selects the cache root (default HOME/.cache).
No writes, credentials, or network requests. Empty input and deletions succeed.
Exit: 0 verified/help, 1 read failure, 2 invalid input/missing record, 3 missing Git.
`

try {
  const { values } = parseArgs({ options: { help: { type: 'boolean', short: 'h' } }, strict: true })
  if (values.help) process.stdout.write(USAGE)
  else checkPushVerification(readFileSync(0, 'utf8'))
} catch (error) {
  console.error(`[pre-push] ${error.message}`)
  process.exitCode = error.exitCode ?? (error.code?.startsWith('ERR_PARSE_ARGS') ? 2 : 1)
}
