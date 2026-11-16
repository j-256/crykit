import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export const RUM_REQUEST_LIMIT = 2000
const INPUTS = Object.freeze(['dist/index.html', 'dist/_headers'])
const PROOFS = Object.freeze({ 'private-state': 'receipt.json', 'hosted-navigation': 'hosted-receipt.json' })
// Each case retains its own request and time budget; neither partial coverage nor an old receipt completes the suite
export function validateRumReceipts(receipts, startedAt, beaconSha256) {
  let inputs
  const summaries = []
  for (const [proof, filename] of Object.entries(PROOFS)) {
    const value = receipts[filename]
    if (!value || value.proof !== proof || value.status !== 'passed' || value.beaconSha256 !== beaconSha256 || !Number.isFinite(Date.parse(value.observedAt)) || Date.parse(value.observedAt) < startedAt || !Number.isSafeInteger(value.requestCount) || value.requestCount <= 0 || value.requestCount > RUM_REQUEST_LIMIT || value.nativeExitVitalsObserved !== true || !Array.isArray(value.rejected) || value.rejected.length || !Array.isArray(value.captures) || !value.captures.length || !Array.isArray(value.scriptRequests) || !value.scriptRequests.length) throw new Error(`Incomplete RUM proof: ${proof}`)
    const actual = JSON.stringify(INPUTS.map(key => value.builtInputs?.[key]))
    if (!value.builtInputs || Object.keys(value.builtInputs).length !== 2 || !INPUTS.every(key => typeof value.builtInputs[key] === 'string' && /^[a-f0-9]{64}$/.test(value.builtInputs[key])) || inputs !== undefined && inputs !== actual) throw new Error('RUM proof input mismatch')
    inputs = actual
    summaries.push({ proof, filename, requestCount: value.requestCount, nativeExitVitalsObserved: true })
  }
  return { status: 'passed', proofs: summaries }
}
export async function completeRumProof(output, startedAt, beaconSha256) {
  const receipts = Object.fromEntries(await Promise.all(Object.values(PROOFS).map(async name => [name, JSON.parse(await readFile(resolve(output, name), 'utf8'))])))
  const result = validateRumReceipts(receipts, startedAt, beaconSha256)
  await writeFile(resolve(output, 'completion.json'), JSON.stringify(result, null, 2) + '\n')
}
