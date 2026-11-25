import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import App from '../../src/App'
import { WorkspaceProvider, useWorkspace } from '../../src/ui/WorkspaceProvider'
import { ErrorBoundary } from '../../src/ui/ErrorBoundary'
import { installProfile, type ProfileToken } from '../../src/account/profile'
import { waitForAccountForeground } from '../../src/account/background-work'
import { getSodium } from '../../src/account/crypto/sodium'
import { accountLocalId, openAccountJson } from '../../src/workspace/account-cache'
import { IncrementalWorkspaceIntentSchema } from '../../src/workspace/account-managed-repository'
import { mapIncrementalAccountIntent } from '../../src/workspace/account-local-mapping-client'
import { createPersonalDefinition } from '../../src/domain'
import { AccountDatabase, activateLocalAccountCommit } from '../../src/persistence/account-database'
import { GuestCoordinatorDatabase } from '../../src/workspace/guest-coordinator'
import { createAccountLocalStore } from '../../src/workspace/account-local-store'
import { createGuestLocalStore } from '../../src/workspace/guest-local-store'
import { prepareLocalWorkspace } from '../../src/workspace/local-root'
import { full, inspect, openAppliedSaveOracle } from './local-save-oracle'
import { localSaveWorkload } from './local-save-workload'
import '../../src/styles.css'

// This entry is built only into excluded synthetic proof assets, never the public application
// Installed keys model local unlocked storage; they do not represent OPAQUE or service authentication
const parameters = new URL(location.href).searchParams
const mode = parameters.get('mode') === 'account' ? 'account' : 'guest'
const large = parameters.get('size') === 'large'
let token: ProfileToken | undefined
let workspace: ReturnType<typeof useWorkspace> | undefined
let opened = false
let opening: Promise<void> | undefined
let mapping: Promise<void> | undefined
let mappingError: string | undefined

function armEditorSaveReadFailure() {
  if (!workspace?.isCurrent() || workspace.repository.kind !== 'account') throw new Error('An active synthetic account is required')
  const { repository, editorSession } = workspace
  const readWorkspace = repository.readWorkspace
  repository.readWorkspace = async (...args) => {
    // Fail one owned save after it captures its ticket and before it can stage a durable write
    if (workspace?.repository === repository && editorSession.phase === 'staging') {
      repository.readWorkspace = readWorkspace
      throw new Error('Synthetic Editor staging read failed')
    }
    return readWorkspace.apply(repository, args)
  }
}

async function queueMapping() {
  if (!token || !workspace?.isCurrent()) throw new Error('An active synthetic account is required')
  const loaded = await workspace.repository.load()
  await workspace.repository.save(createPersonalDefinition(loaded.localData, { kind: 'item', name: 'Synthetic queued projection' }), loaded.revision)
}

async function startMapping() {
  if (!token) throw new Error('An active synthetic account is required')
  if (mappingError) throw new Error(mappingError)
  if (mapping) return
  const captured = token, database = new AccountDatabase(captured.accountId)
  const pending = []
  for (const row of await database.outbox.toArray()) if (row.status === 'unmapped-local') {
    pending.push({ row, intent: await openAccountJson(database, captured, row.ref, IncrementalWorkspaceIntentSchema) })
  }
  pending.sort((left, right) => left.intent.sequence - right.intent.sequence)
  if (!pending.length) { database.close(); throw new Error('The benchmark requires queued projection') }
  // Use the actual captured-profile worker and exact outbox CAS, without holding its scheduling units open
  mapping = mapIncrementalAccountIntent(database, captured, pending[0].row).catch(error => { mappingError = String(error) }).finally(() => { database.close(); mapping = undefined })
}

function Entry() {
  const current = useWorkspace()
  useEffect(() => {
    workspace = current
    if (token && !opening) opening = (async () => {
      // The normal guest opening precedes explicit account activation; finish its bulk admission
      // before measuring account edits so abandoned startup work cannot contaminate ordinary saves
      if (current.repository.kind === 'guest') await current.repository.load()
      await current.openAccount(token!)
      opened = true
    })()
    if (!token && current.repository.kind === 'guest') opened = true
  }, [current])
  return <App/>
}

async function start() {
  const cacheStarted = performance.now()
  if (import.meta.env.PROD) {
    await navigator.serviceWorker.register('./sw.js')
    await navigator.serviceWorker.ready
    if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }))
  }
  const cachePreparationMs = performance.now() - cacheStarted
  const state = await localSaveWorkload(large), started = performance.now(), operation = accountLocalId()
  if (mode === 'account') {
    token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
    const database = new AccountDatabase(token.accountId), store = createAccountLocalStore(database, token)
    try {
      const prepared = await prepareLocalWorkspace(store.adapter, operation, state, store.lifetime)
      await activateLocalAccountCommit(database, token, await store.prepareActivation(operation, prepared, undefined))
      store.committed(operation)
    } finally { await store.dispose(); database.close() }
  } else {
    const database = new GuestCoordinatorDatabase(), store = createGuestLocalStore(database, () => {})
    try {
      const prepared = await prepareLocalWorkspace(store.adapter, operation, state, { check() {}, async assertCurrent() {} })
      await store.activate(operation, prepared.head, undefined, () => {})
    } finally { database.close() }
  }
  const saveApplyOracle = parameters.get('saveApplyOracle') === '1' ? await openAppliedSaveOracle(token) : undefined
  if (saveApplyOracle) window.addEventListener('pagehide', saveApplyOracle.close, { once: true })
  const setupMs = performance.now() - started
  Object.assign(window, { localSaveProof: {
    setup: { mode, large, setupMs, cachePreparationMs, build: import.meta.env.PROD ? 'compiled' : 'development', origin: location.origin, scripts: [...document.scripts].map(script => script.src) },
    ready: () => opened && !!workspace?.isCurrent(),
    diagnostics: () => ({ kind: workspace?.repository.kind, current: workspace?.isCurrent(), pending: workspace?.fileCommandPending(), editorPhase: workspace?.editorSession.phase, editorDirty: workspace?.editorSession.controller.snapshot().dirty, editorHydrating: !!workspace?.editorSession.hydration, savePhase: workspace?.saveSession.phase, saveDirty: workspace?.saveSession.controller.snapshot().dirty, saveHydrating: !!workspace?.saveSession.hydration }),
    inspect: (kind: 'planner' | 'save' | 'editor', editorId?: string) => inspect(token, kind, editorId),
    ...(saveApplyOracle && { beginSaveApply: saveApplyOracle.begin, captureSaveApply: saveApplyOracle.capture, inspectSaveApply: saveApplyOracle.read }),
    armEditorSaveReadFailure,
    waitForForeground: () => {
      if (!token) throw new Error('An active synthetic account is required')
      return waitForAccountForeground(token)
    },
    queueMapping, startMapping,
    mapping: () => ({ pending: !!mapping, error: mappingError }),
    full: () => full(token),
    sodium: await getSodium(),
  } })
  createRoot(document.getElementById('root')!).render(<StrictMode><ErrorBoundary><WorkspaceProvider><Entry/></WorkspaceProvider></ErrorBoundary></StrictMode>)
}
void start().catch(error => { document.body.textContent = String(error); Object.assign(window, { localSaveFailure: String(error) }) })
