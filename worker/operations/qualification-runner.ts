import { WorkerEntrypoint } from 'cloudflare:workers'

interface QualificationProbeEnv {
  readonly QUALIFICATION_RUN_ID?: string
  readonly QUALIFICATION_CODE_VERSION?: string
}
const runIdentity = /^[A-Za-z0-9_-]{1,64}$/
const codeIdentity = /^[a-f0-9]{64}$/

// This separately deployed entry proves private native RPC before any recovery authority is introduced
// Keep the default HTTP entry inert and do not import service contexts, resources or fixture controls
export class QualificationOps extends WorkerEntrypoint<QualificationProbeEnv> {
  status() {
    const runId = this.env.QUALIFICATION_RUN_ID
    const codeVersion = this.env.QUALIFICATION_CODE_VERSION
    if (!runId || !runIdentity.test(runId) || !codeVersion || !codeIdentity.test(codeVersion)) throw new Error('QUALIFICATION_PROBE_UNAVAILABLE')
    // The operator supplies a nonsecret artifact digest and verifies it against uploaded-version readback
    // Echoing configured metadata alone does not attest deployment identity or qualify runtime capacity
    return { version: 1, service: 'crykit-qualification-ops', mode: 'inert', runId, codeVersion }
  }
}

export default {
  fetch() { return new Response(null, { status: 404 }) },
} satisfies ExportedHandler
