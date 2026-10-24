import type { ServiceContext } from '../context'
import { captureServiceSnapshot } from '../jobs/service-backup'
import { measuredDatabase } from './measured-database'
import { maxCaptureErrorMessageCharacters, maxCaptureErrorNameCharacters, type CaptureStepOutcome } from './capture-step-contract'

// One invocation is one continuation step, preserving query limits and interrupted-work boundaries
// Context and native bindings belong to the excluded local entry, never to serialized test callbacks
export async function captureServiceSnapshotStep(context: ServiceContext, snapshot: string): Promise<CaptureStepOutcome> {
  const meter = measuredDatabase(context.env.DB!)
  const measured = { ...context, env: { ...context.env, DB: meter.db } }
  try {
    return { ok: true, receipt: await captureServiceSnapshot(measured, snapshot), measurements: meter.values }
  } catch (error) {
    if (!(error instanceof Error)) throw error
    // Only the synthetic harness returns bounded error details to preserve Node failure assertions
    const code = 'code' in error && typeof error.code === 'string' ? error.code.slice(0, maxCaptureErrorNameCharacters) : undefined
    return { ok: false, error: { name: error.name.slice(0, maxCaptureErrorNameCharacters), message: error.message.slice(0, maxCaptureErrorMessageCharacters), code }, measurements: meter.values }
  }
}
