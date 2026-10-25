#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { verifyVitest } from './vitest-verification.mjs'

const USAGE = `Usage: npm run test:vitest:prepared -- [-h|--help]
Run all prepared Vitest projects from the repository root without test filters.
Local Node projects overlap independent serial native Worker/persistence shards.
Each native shard stops after its first failure and that case's cleanup.
All children drain before results merge; every child and report merge must pass.
CI retains its configured single-process scheduling and worker limits.
Requires Node.js, npm ci, and the Worker modules from build:account-tests.
vite.config.ts defines the checked project matrix and per-project settings.
Reports and prior attempt diagnostics remain beneath .account-tests/.
The combined JSON report is .account-tests/vitest-results.json.
This command creates no publication record; npm run verify owns that gate.
Exit: 0 passed/help, 1 test/report failure, 2 usage/configuration, 3 missing tool.
`

try {
  const { values } = parseArgs({ options: { help: { type: 'boolean', short: 'h' } }, strict: true, allowPositionals: false })
  if (values.help) process.stdout.write(USAGE)
  else await verifyVitest()
} catch (error) {
  console.error(`[vitest] ${error.message}`)
  process.exitCode = error.exitCode ?? (error.code?.startsWith('ERR_PARSE_ARGS') ? 2 : error.code === 'ERR_MODULE_NOT_FOUND' ? 3 : 1)
}
