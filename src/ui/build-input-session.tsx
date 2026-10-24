import { downloadBytes } from './model'
import { createContext, useContext, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction, type ReactNode } from 'react'
import type { ImportPreview } from '../interchange/types'
import { BuildInputController, type BuildInputField, type BuildInputView } from '../workspace/build-input-controller'
import type { OwnedFileCommand, OwnedFileCompletion, OwnedFileOutcome } from '../workspace/owned-file-command'
import { useWorkspace } from './WorkspaceProvider'
import { Button, InlineNotice } from './components'

export interface BuildInputSession {
  readonly controller: BuildInputController
  scope?: string
  view?: BuildInputView
  phase: 'idle' | 'staging' | 'hydrating' | 'recovery'
  hydration?: { readonly completion: OwnedFileCompletion; readonly generation: number; confirmation?: Promise<void> }
  recovery?: { readonly outcome: OwnedFileOutcome; readonly command: OwnedFileCommand }
}
export const createBuildInputSession = (): BuildInputSession => ({ controller: new BuildInputController(), phase: 'idle' })
export interface BuildInputActions {
  readonly buildInputSession: BuildInputSession
  importBuildSource(preview: ImportPreview, expected: { readonly id: string; readonly revision: number }): Promise<void>
  confirmBuildHydration(view: BuildInputView): Promise<void>
  retryBuildImport(): Promise<void>
}
interface BuildInputContextValue { readonly controller: BuildInputController; readonly view: BuildInputView; readonly pending: boolean }
const BuildInputContext = createContext<BuildInputContextValue | undefined>(undefined)
export const useBuildInput = () => useContext(BuildInputContext)
export function useBuildInputState<T>(key: BuildInputField, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const context = useBuildInput()
  const [value, setValue] = useState<T>(() => {
    const make = () => typeof initial === 'function' ? (initial as () => T)() : initial
    return context ? context.controller.read(context.view, key, make) : make()
  })
  const latest = useRef(value)
  latest.current = value
  const update: Dispatch<SetStateAction<T>> = next => {
    const resolved = typeof next === 'function' ? (next as (value: T) => T)(latest.current) : next
    // Store at event time so a completion cannot transfer an older render's input
    context?.controller.edit(context.view, key, resolved)
    latest.current = resolved; setValue(resolved)
  }
  return [value, update]
}
export function BuildInputProvider({ children, scope }: { readonly children: ReactNode; readonly scope: string }) {
  const workspace = useWorkspace(), session = workspace.buildInputSession
  const view = useMemo(() => {
    if (session.scope !== scope) {
      if (session.phase !== 'idle') throw new Error('Keep the importing Build open until its outcome is known')
      session.controller.revoke(); session.view = undefined; session.scope = scope
    }
    return session.view ?? (session.view = session.controller.attach())
  }, [scope, session])
  const [error, setError] = useState<string>()
  const [retrying, setRetrying] = useState(false)
  const [ready, setReady] = useState(!session.hydration)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    void workspace.confirmBuildHydration(view).then(() => { if (mounted.current) setReady(true) }).catch(reason => { if (mounted.current) setError(String(reason)) })
    return () => {
      mounted.current = false
      queueMicrotask(() => { if (!mounted.current && session.view === view && session.phase === 'idle') { session.controller.release(view); session.view = undefined } })
    }
  }, [view])
  // No loaded planner state is installed here; the new App already owns the verified successor
  const value = { controller: session.controller, view, pending: !ready || session.phase !== 'idle' }
  const recovery = session.phase === 'recovery' && session.recovery
  const saved = recovery && recovery.outcome.status === 'saved' || Boolean(session.hydration)
  const retry = async () => {
    if (retrying) return
    setRetrying(true)
    try { await workspace.retryBuildImport(); if (mounted.current) { setError(undefined); setReady(true) } }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (mounted.current) setRetrying(false) }
  }
  // Recovery belongs to the form owner, outside its disabled fieldsets and any dismissible picker
  return <BuildInputContext.Provider value={value}>{(error || recovery) && <section aria-label="Build import recovery"><InlineNotice title="Build input needs recovery" tone="warning"><p>{saved ? 'The mod is saved in your library. Your Build is still unsaved.' : 'The import outcome needs checking. Your Build input is kept here.'}</p>{error && <p>{error}</p>}<BuildInputRecoveryDownload/><Button disabled={retrying} type="button" onClick={() => void retry()}>Retry reopening</Button></InlineNotice></section>}{children}</BuildInputContext.Provider>
}

export function BuildInputRecoveryDownload() {
  const input = useBuildInput(), workspace = useWorkspace()
  if (!input) return null
  return <Button type="button" tone="secondary" onClick={() => {
    if (!workspace.isCurrent()) throw new Error('The Build recovery owner was retired')
    const values = input.controller.recoveryInput(input.view)
    // Inert recovery values omit live owner identity, receipts, callbacks and repository permissions
    downloadBytes(new TextEncoder().encode(JSON.stringify({ format: 'crykit-build-input-recovery', version: 1, values }, null, 2)), 'build-input-recovery.json', 'application/json')
  }}>Download Build input</Button>
}
