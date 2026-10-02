#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

// Literal routes belong in contract coverage so feature tests cannot retain old formats
const ROUTE_CONTRACT_FILES = new Set(['e2e/entity-urls.spec.ts'])
const CATALOG_PATH_PATTERN = /\/reference\/catalog\/|(?:^|[/'"`])entities\/|(?:^|[/'"`])(?:base|mod)\/[^\s/'"`]+\/|\/mode\/(?:Chaos|Vanilla)\//
const IDENTITY_SPLIT_PATTERN = /\.split\(\s*(['"]):\1\s*\)/
const USAGE = `Usage: node scripts/check-e2e-contracts.mjs [-h|--help]
Check E2E source for duplicated catalog paths and colon-based ID serialization.
Use referencePath/referenceUrlPattern from e2e/reference-helpers.ts in feature tests.
Explicit URL formats belong in e2e/entity-urls.spec.ts, the reviewed route contract.
Requires Node.js and the e2e directory in the working directory. No environment
variables, credentials, writes, or network requests.
Exit: 0 clean/help, 1 findings/read failure, 2 invalid arguments.
`

export function inspectE2EContracts(file, contents) {
  if (ROUTE_CONTRACT_FILES.has(file.replaceAll('\\', '/'))) return []
  return contents.split('\n').flatMap((line, index) => {
    const normalized = line.replace(/\\\//g, '/')
    const reason = CATALOG_PATH_PATTERN.test(normalized) ? 'Use the shared reference helper instead of a catalog path' :
      IDENTITY_SPLIT_PATTERN.test(line) ? 'Use the shared reference helper instead of serializing entity IDs' : undefined
    return reason ? [`${file}:${index + 1}: ${reason}`] : []
  })
}

export function checkE2EContracts(directory = 'e2e') {
  const findings = []
  function inspect(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name)
      if (entry.isDirectory()) inspect(file)
      else if (entry.isFile() && /\.tsx?$/.test(file)) findings.push(...inspectE2EContracts(file, readFileSync(file, 'utf8')))
    }
  }
  inspect(directory)
  return findings
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { help: { type: 'boolean', short: 'h' } }, strict: true })
    if (values.help) process.stdout.write(USAGE)
    else {
      const findings = checkE2EContracts()
      if (findings.length) { console.error(findings.join('\n')); process.exitCode = 1 }
      else console.log('E2E contract check passed')
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = error.code?.startsWith('ERR_PARSE_ARGS') ? 2 : 1
  }
}
