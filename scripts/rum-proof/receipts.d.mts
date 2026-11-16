export const RUM_REQUEST_LIMIT: number
export function validateRumReceipts(receipts: Record<string, unknown>, startedAt: number, beaconSha256: string): {
  status: 'passed'
  proofs: Array<{ proof: string; filename: string; requestCount: number; nativeExitVitalsObserved: true }>
}
export function completeRumProof(output: string, startedAt: number, beaconSha256: string): Promise<void>
