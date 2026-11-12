#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { verifyIntegration } from './integration-verification.mjs'
import { coordinateVerification } from './verification-coordination.mjs'

const USAGE = `Usage: npm run verify -- [-h|--help] [-I|--if-needed] [-r|--resume]
Prepare each required build once, then pass prerequisite checks and exclusive saves.
Run Vitest only after the complete save-performance project passes.
After Vitest passes, run guest browsers alongside isolated HTTPS account journeys.
Every required command must pass; ownership lasts until running siblings settle.
Requires Node.js, npm, Git, npm ci, openssl, and Playwright Chromium, Firefox, WebKit.
Run npx playwright install chromium firefox webkit to install the test browsers.
No positional arguments or test filters are accepted.
CRYKIT_E2E_PORT selects the local preview port (default 4173).
Account acceptance workers own ephemeral HTTPS loopback ports and fresh backends.
Installed, configured wt-queue coordinates full runs and checks base freshness.
Other clones can verify standalone without wt-queue. Busy coordination exits 4.
CRYKIT_WT_QUEUE selects a coordinator executable for review or custom installs.
WT_QUEUE_VERIFICATION_TOKEN is issued by the coordinator for scoped nested runs.
-r, --resume rebuilds inputs and reuses passing checkpoints for matching inputs.
-I, --if-needed uses the same resume behavior for integration queues.
Guest and account browser phases use complete, sequential shard partitions.
Failures and their per-attempt reports remain available after recovery.
XDG_CACHE_HOME selects the cache root (default HOME/.cache).
Records live in crykit-verification beneath that root and are scoped to the
Git repository, exact committed tree, and Node version/platform/architecture.
Dirty source can be tested but creates no publication record. Commit and
synchronize before verification to authorize that tree for the pre-push hook.
Failed or interrupted reruns invalidate previous success for the same tree.
No game data requests occur; configured coordination fetches the Git base.
Exit: 0 passed/help, 1 check failure, 2 usage/changed source, 3 missing tool,
4 coordinated verification or approved integration is busy.
`

try {
  const { values } = parseArgs({ options: { help: { type: 'boolean', short: 'h' }, 'if-needed': { type: 'boolean', short: 'I' }, resume: { type: 'boolean', short: 'r' } }, strict: true })
  if (values.help) process.stdout.write(USAGE)
  else await coordinateVerification(() => verifyIntegration({ ifNeeded: values['if-needed'], resume: values.resume }))
} catch (error) {
  console.error(`[verify] ${error.message}`)
  process.exitCode = error.exitCode ?? (error.code?.startsWith('ERR_PARSE_ARGS') ? 2 : 1)
}
