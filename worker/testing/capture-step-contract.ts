import { z } from 'zod'
import { OpaqueIdSchema, type JobReceipt, type SafeEvent } from '../../src/account/protocol'
import type { DatabaseMeasurements } from './measured-database'

export const captureStepPath = '/__accounts/probe/capture-step'
export const CaptureStepRequestSchema = z.strictObject({ snapshot: OpaqueIdSchema })
export const maxCaptureErrorNameCharacters = 64
export const maxCaptureErrorMessageCharacters = 512

export interface CaptureStepResult {
  readonly receipt: JobReceipt
  readonly measurements: DatabaseMeasurements
  readonly events: readonly SafeEvent[]
}

export type CaptureStepOutcome =
  | { readonly ok: true; readonly receipt: JobReceipt; readonly measurements: DatabaseMeasurements }
  | { readonly ok: false; readonly error: { readonly name: string; readonly message: string; readonly code?: string }; readonly measurements: DatabaseMeasurements }
