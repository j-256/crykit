import { initializeMatchedStarter, type StarterApi } from './signin-matched-starter-core'
import type { GuestCoordinatorDatabase } from '../../src/workspace/guest-coordinator'
import type { readWorkspaceBackup } from '../../src/interchange/workspace-backup'
import type { disposeWorkspaceSnapshot } from '../../src/workspace/snapshot'
export interface StarterModule { path: string; sha256: string; exported: string; property?: string }
export type StarterModules = Record<keyof StarterApi | 'GuestCoordinatorDatabase' | 'getDatabase' | 'readWorkspaceBackup' | 'disposeWorkspaceSnapshot', StarterModule>
export async function installStarter(modules: StarterModules, archiveUrl: string, destinationChanges: Parameters<typeof initializeMatchedStarter>[3]) {
  if (!new URLSearchParams(location.search).has('fixture-setup') || document.querySelector('main')) throw new Error('Matched starter needs unmounted fixture entry')
  const imported: Record<string, unknown> = {}
  for (const [name, spec] of Object.entries(modules)) {
    const module = await import(/* @vite-ignore */ spec.path)
    imported[name] = spec.property ? module[spec.exported]?.[spec.property] : module[spec.exported]
    if (typeof imported[name] !== 'function') throw new Error(`Required starter export unavailable: ${name}`)
  }
  const api = imported as unknown as StarterApi
  const profile = api.captureGuestWorkspaceEpoch()
  const check = () => profile.assertCurrent()
  check()
  const name = (imported.getDatabase as () => { name: string })().name + '-coordinator'
  const Database = imported.GuestCoordinatorDatabase as typeof GuestCoordinatorDatabase
  const database = new Database(name)
  let snapshot: Awaited<ReturnType<typeof readWorkspaceBackup>> | undefined
  try {
    check()
    if ((await indexedDB.databases()).some(value => value.name === name)) throw new Error('Matched starter target database already exists')
    check()
    const response = await fetch(archiveUrl)
    if (!response.ok || !response.body) throw new Error('Frozen starter archive unavailable')
    const source = { async *[Symbol.asyncIterator]() { const reader = response.body!.getReader(); try { for (;;) { check(); const item = await reader.read(); check(); if (item.done) return; yield item.value } } finally { reader.releaseLock() } } }
    snapshot = await (imported.readWorkspaceBackup as typeof readWorkspaceBackup)(source)
    check()
    if (snapshot.version !== 1) throw new Error('Matched starter must be its actual V1 current capture')
    return await initializeMatchedStarter(api, database, snapshot.state, destinationChanges, profile.signal)
  } finally {
    try { if (snapshot) await (imported.disposeWorkspaceSnapshot as typeof disposeWorkspaceSnapshot)(snapshot) }
    finally { database.close() }
  }
}
