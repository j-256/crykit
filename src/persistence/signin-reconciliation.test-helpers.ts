import { expect, vi } from 'vitest'
import { runSyncIteration } from '../account/sync/outbox'
import { LAUNCH_DATA_GENERATION } from '../domain/data-generation'
import { createBlankLocalData } from '../domain/local-data'
import * as reconciliation from '../workspace/signin-reconciliation'
import { workspace, progress, now } from '../workspace/signin-merge.test-helpers'
import { ownWorkspaceSnapshot } from '../workspace/snapshot'
import { prepareManagedSync } from './managed-sync.test-helpers'
import { conflictService } from './sync-conflict-fixture'

type ConflictService = Awaited<ReturnType<typeof conflictService>>

export function createSigninReconciliationSetup(
  ownService: (service: ConflictService) => void,
  controllers: ReturnType<typeof reconciliation.createSigninReconciliation>[],
) {
  return async function setup(guest = progress('guest'), initial = workspace(createBlankLocalData({ now }))) {
    const service = await conflictService()
    // Register the service before subsequent fixture operations can fail so the calling file can dispose it
    ownService(service)
    const device = await service.device(0, initial)
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }))
    vi.stubGlobal('window', new EventTarget()); vi.stubGlobal('navigator', { onLine: true })
    let captures = 0, opens = 0, locals = 0, failOpen = false
    const options: { -readonly [K in keyof reconciliation.SigninReconciliationOptions]: reconciliation.SigninReconciliationOptions[K] } = {
      captureGuest: async () => ({ snapshot: ownWorkspaceSnapshot({ version: 1 as const, dataGeneration: LAUNCH_DATA_GENERATION, snapshotId: `capture-${++captures}`, capturedAt: String(captures), revisionVector: { guest: 'instance-one', managedRevision: '1' }, state: guest }, { async check() {}, async dispose() {} }) }),
      run: async (token: typeof device.token, signal: AbortSignal) => { await prepareManagedSync(device.db, token); return runSyncIteration(token, signal) },
      openAccount: async () => { if (failOpen) throw new Error('selection failure'); opens++ },
      continueLocal: async () => { locals++ },
    }
    const create = () => { const controller = reconciliation.createSigninReconciliation(options); controllers.push(controller); return controller }
    return { device, options, create, guest, get opens() { return opens }, get locals() { return locals }, set failOpen(value: boolean) { failOpen = value } }
  }
}

export async function interruptMergeActivation(controller: ReturnType<typeof reconciliation.createSigninReconciliation>) {
  const activation = await import('./account-database')
  const failure = vi.spyOn(activation, 'activateLocalAccountCommit').mockRejectedValueOnce(new Error('QUOTA_EXCEEDED'))
  try { await controller.confirm(); expect(controller.getSnapshot()).toMatchObject({ phase: 'failed', reason: 'quota' }) }
  finally { failure.mockRestore() }
}
