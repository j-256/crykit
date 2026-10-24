import { cp, mkdtemp } from 'node:fs/promises'
import { resolve } from 'node:path'

export default async function setup() {
  // Copy only immutable builds once per attempt; no database, browser storage or key is shared
  // Retain the snapshot for failure diagnosis, independently of worker process lifetimes
  const output = resolve('.account-tests')
  const directory = await mkdtemp(resolve(output, 'acceptance-inputs-'))
  await cp(resolve('wrangler.local.jsonc'), resolve(directory, 'wrangler.local.jsonc'))
  await cp(resolve('dist'), resolve(directory, 'assets'), { recursive: true })
  await cp(resolve(output, 'browser'), resolve(directory, 'assets/__accounts-proof'), { recursive: true })
  await cp(resolve(directory, 'assets/__accounts-proof/crypto-proof.html'), resolve(directory, 'assets/__accounts-proof/index.html'))
  for (const name of ['local', 'production', 'wasm', 'opaque-adapter']) await cp(resolve(output, name), resolve(directory, name), { recursive: true })
  process.env.CRYKIT_ACCOUNT_INPUTS = directory
}
