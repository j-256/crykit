#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { verifyIntegration } from './integration-verification.mjs'

const USAGE = `Usage: npm run verify -- [-h|--help]
Run npm run check and the complete desktop/mobile browser suite.
Requires Node.js, npm, Git, npm ci, and Playwright Chromium.
Run npx playwright install chromium to install the test browser.
No positional arguments or test filters are accepted.
CRYKIT_E2E_PORT selects the local preview port (default 4173).
XDG_CACHE_HOME selects the cache root (default HOME/.cache).
Records live in crykit-verification beneath that root and are scoped to the
Git repository, exact committed tree, and Node version/platform/architecture.
Dirty source can be tested but creates no publication record. Commit and
synchronize before verification to authorize that tree for the pre-push hook.
Failed or interrupted reruns invalidate previous success for the same tree.
No credentials or external network requests are needed; generated outputs are rebuilt.
Exit: 0 passed/help, 1 check failure, 2 usage/changed source, 3 missing tool.
`

try {
  const { values } = parseArgs({ options: { help: { type: 'boolean', short: 'h' } }, strict: true })
  if (values.help) process.stdout.write(USAGE)
  else await verifyIntegration()
} catch (error) {
  console.error(`[verify] ${error.message}`)
  process.exitCode = error.exitCode ?? (error.code?.startsWith('ERR_PARSE_ARGS') ? 2 : 1)
}
