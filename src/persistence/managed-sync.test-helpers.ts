import { AccountDatabase } from './account-database'
import { accountLocalId } from '../workspace/account-cache'

// Browser coverage owns the Worker transport; this Node composition executes its exact durable tickets
export async function prepareManagedSync(database: AccountDatabase, token: import('../account/profile').ProfileToken) {
  const { isManagedAccountHead } = await import('../workspace/account-sync-capture')
  const { prepareIncrementalMapping, activateIncrementalMapping, prepareIncrementalBaseline, activateIncrementalBaseline, readIncrementalMappedRoot } = await import('../workspace/account-local-mapping')
  const { IncrementalWorkspaceIntentSchema } = await import('../workspace/account-managed-repository')
  const { openAccountJson } = await import('../workspace/account-cache')
  const fence = (await database.profileMeta.get('active'))!
  if (!await isManagedAccountHead(database, token, fence)) return
  const pending = await Promise.all((await database.outbox.toArray()).filter(row => row.status === 'unmapped-local').map(async row => ({ row, intent: await openAccountJson(database, token, row.ref, IncrementalWorkspaceIntentSchema) })))
  for (const { row } of pending.sort((a, b) => a.intent.sequence - b.intent.sequence)) await activateIncrementalMapping(database, token, await prepareIncrementalMapping(database, token, row))
  if (!await readIncrementalMappedRoot(database, token, fence)) await activateIncrementalBaseline(database, token, await prepareIncrementalBaseline(database, token, fence))
}

export async function seedManagedWorkspace(database: AccountDatabase, token: import('../account/profile').ProfileToken, state: import('../workspace/documents').WorkspaceState) {
  const { createAccountLocalStore } = await import('../workspace/account-local-store')
  const { prepareLocalWorkspace } = await import('../workspace/local-root')
  const { activateLocalAccountCommit } = await import('./account-database')
  const store = createAccountLocalStore(database, token), operationId = accountLocalId()
  try {
    // These ordinary sync subjects start in the fresh layout without inventing a retained legacy branch
    const prepared = await prepareLocalWorkspace(store.adapter, operationId, state, store.lifetime)
    await activateLocalAccountCommit(database, token, await store.prepareActivation(operationId, prepared, undefined))
    store.committed(operationId)
  } finally { await store.dispose() }
}

// Native publication assertions consume the real mapped projection, never the compact selected root
export async function openManagedNativeWorkspace(database: AccountDatabase, token: import('../account/profile').ProfileToken) {
  await prepareManagedSync(database, token)
  const { readIncrementalMappedRoot } = await import('../workspace/account-local-mapping')
  const { openAccountWorkspace } = await import('../workspace/account-graph')
  const selected = (await database.profileMeta.get('active'))!
  const mapped = await readIncrementalMappedRoot(database, token, selected)
  if (!mapped) throw new Error('The selected managed fixture has no authenticated native mapping')
  return openAccountWorkspace(database, token, mapped)
}
