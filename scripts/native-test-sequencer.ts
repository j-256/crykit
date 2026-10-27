import { relative, sep } from 'node:path'
import { BaseSequencer, type TestSpecification } from 'vitest/node'

// Rounded relative costs from complete local verification, not deadlines or eligibility rules
// Include the short files too so their default weight cannot distort the measured balance
// Unknown files always receive a positive weight and remain required
const DEFAULT_TEST_COST = 20
const NATIVE_TEST_COSTS: Readonly<Record<string, number>> = Object.freeze({
  'e2e/accounts/cleanup-persistence.proof.mjs': 5,
  'src/persistence/conflicts.test.ts': 225,
  'src/persistence/copied-conflict-journey.test.ts': 75,
  'src/persistence/lineage-conflicts.test.ts': 115,
  'src/persistence/mapping-bulk-conflicts.test.ts': 105,
  'src/persistence/mapping-conflicts.test.ts': 115,
  'src/persistence/publication-empty-page.test.ts': 5,
  'src/persistence/sync-integration-managed.test.ts': 70,
  'src/persistence/sync-integration-originals.test.ts': 45,
  'src/persistence/sync-integration.test.ts': 35,
  'worker/admin/auth.test.ts': 20,
  'worker/admin/commands.test.ts': 25,
  'worker/admin/effects.test.ts': 5,
  'worker/admin/invitations.test.ts': 5,
  'worker/admin/panel-assets.test.ts': 1,
  'worker/admin/restore.test.ts': 25,
  'worker/admission.test.ts': 10,
  'worker/alerts/index.test.ts': 1,
  'worker/alerts/policy.test.ts': 1,
  'worker/auth/access.test.ts': 30,
  'worker/auth/credentials.test.ts': 25,
  'worker/auth/devices.test.ts': 20,
  'worker/auth/opaque.test.ts': 5,
  'worker/auth/rate-limits.test.ts': 1,
  'worker/db/guarded-batch.test.ts': 25,
  'worker/diagnostics.test.ts': 1,
  'worker/email/jobs.test.ts': 25,
  'worker/jobs/cleanup.test.ts': 1,
  'worker/jobs/deletion.test.ts': 40,
  'worker/jobs/ledger.test.ts': 15,
  'worker/jobs/runner.test.ts': 1,
  'worker/jobs/service-backup.test.ts': 80,
  'worker/jobs/service-recovery-browser.test.ts': 20,
  'worker/runtime.test.ts': 10,
  'worker/shares/publication.test.ts': 15,
  'worker/shares/rate-limits.test.ts': 5,
  'worker/sync/certificates.test.ts': 25,
  'worker/sync/cleanup.test.ts': 10,
  'worker/sync/commit.test.ts': 60,
  'worker/sync/transitions.test.ts': 30,
  'worker/sync/uploads.test.ts': 35,
  'worker/testing/database-request.test.ts': 5,
})

export default class NativeTestSequencer extends BaseSequencer {
  async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { root, shard } = this.ctx.config
    if (!shard) return files
    const bins = Array.from({ length: shard.count }, () => ({ cost: 0, files: [] as TestSpecification[] }))
    const ranked = files.map(spec => {
      const path = relative(root, spec.moduleId).split(sep).join('/')
      return { spec, key: JSON.stringify([path, spec.project.name]), cost: NATIVE_TEST_COSTS[path] ?? DEFAULT_TEST_COST }
    }).sort((a, b) => b.cost - a.cost || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    // Every shard derives the same assignment from discovery, independent of input order or local caches
    // This changes placement only; inherited sorting and each serial process's cleanup remain intact
    for (const { spec, cost } of ranked) {
      const target = bins.reduce((least, bin) => bin.cost < least.cost ? bin : least)
      target.files.push(spec)
      target.cost += cost
    }
    return bins[shard.index - 1].files
  }
}
