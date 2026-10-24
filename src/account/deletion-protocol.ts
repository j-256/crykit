import { z } from 'zod'

export const deletionConfirmation = 'DELETE MY ACCOUNT'
export const deletionStatusHeader = 'x-deletion-status'
export const deletionPhases = ['ledger','fence','liabilities','transfer','metadata','envelopes','account','complete'] as const
export const serviceFailureCodes = ['RETRY_PENDING','INTEGRITY_FAILED','LEDGER_UNAVAILABLE','LEDGER_NOT_READY','LEDGER_INVALID','LEDGER_CORRUPT','LEDGER_INCOMPLETE','LEDGER_REGRESSED','LEDGER_INTENT_MISMATCH','LEDGER_CONTENTION','LEDGER_CHANGED'] as const
export const DeletionStatusSchema = z.strictObject({ state: z.enum(['pending','complete']), phase: z.enum(deletionPhases), code: z.enum(serviceFailureCodes).optional() })
export type DeletionStatus = z.infer<typeof DeletionStatusSchema>
