import { useEffect, useRef, useState } from 'react'
import { assertActiveProfile, type ProfileToken } from '../../account/profile'
import type { WorkspaceRepository } from '../../workspace/repository'
import type { WorkspaceConflict, WorkspaceDocument, WorkspaceState } from '../../workspace/documents'
import { inspectWorkspaceClosure } from '../../workspace/closure'
import { resolveConflict } from '../../workspace/conflicts'
import { ConflictFileVersion } from './ConflictFileVersion'
import { publishedSupersededConflicts } from '../../account/sync/conflict-status'

interface ComparedConflict { readonly conflict: WorkspaceConflict; readonly versions: readonly { value: unknown; documents: readonly WorkspaceDocument[] }[]; readonly active: boolean; readonly copyAvailable: boolean }
interface Inspection { readonly token: ProfileToken; readonly revision: number; readonly blobs: WorkspaceState['blobs']; readonly conflicts: readonly ComparedConflict[] }
const errors: Readonly<Record<string, string>> = {
  STALE_CONFLICT_CHOICE: 'The accepted version changed. Refresh the comparison before choosing again. Both saved versions are retained.',
  LOCAL_REVISION_CONFLICT: 'Saved data changed while you were choosing. Refresh the comparison before trying again.',
  CONFLICT_DEPENDENCY_IN_USE: 'Other records still use a different pinned version. Keep this conflict until those records can be changed together.',
  CONFLICT_COPY_UNAVAILABLE: 'This record has no independent copy action. Both original versions are retained.',
}
export function ConflictPanel({ token, repository }: { readonly token: ProfileToken; readonly repository: Pick<WorkspaceRepository, 'readWorkspace' | 'subscribe'> }) {
  const [inspection, setInspection] = useState<Inspection>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const lifetime = useRef(0)
  useEffect(() => {
    const captured = ++lifetime.current
    setError(''); setBusy(false)
    let readSequence = 0
    const read = async () => {
      const sequence = ++readSequence
      try {
        const state = await repository.readWorkspace()
        const conflicts: ComparedConflict[] = []
        const superseded = await publishedSupersededConflicts(token, state)
        for (const conflict of state.conflicts) {
          const branches = await Promise.all(conflict.branches.map(branch => inspectWorkspaceClosure(state, branch.closure)))
          conflicts.push({ conflict, active: conflict.disposition.kind === 'unresolved' && !superseded.has(conflict.id), copyAvailable: JSON.parse(conflict.unit.privateKey)[0] === 'build' && branches.every(value => value.root.kind === 'build'), versions: branches.map(value => ({ value: value.value, documents: [...value.documents.values()] })) })
        }
        assertActiveProfile(token)
        if (lifetime.current === captured && sequence === readSequence) setInspection({ token, revision: state.planner.localData.revision, blobs: state.blobs, conflicts })
      } catch {
        if (lifetime.current === captured && sequence === readSequence) setError('Saved versions could not be read. Retry to inspect them before choosing.')
      }
    }
    void read()
    const unsubscribe = repository.subscribe(() => { void read() })
    return () => { lifetime.current++; unsubscribe() }
  }, [token, repository, refresh])
  const current = inspection?.token === token ? inspection : undefined
  async function choose(conflict: WorkspaceConflict, choice: 'this' | 'other' | 'both') {
    if (!current || busy) return
    const captured = lifetime.current
    setBusy(true); setError('')
    try { await resolveConflict(token, conflict.id, choice, current.revision); assertActiveProfile(token); if (captured === lifetime.current) setRefresh(value => value + 1) }
    catch (reason) { if (captured === lifetime.current) setError(errors[reason instanceof Error ? reason.message : ''] ?? 'The choice could not be saved. Both versions are retained. Retry when ready.') }
    finally { if (captured === lifetime.current) setBusy(false) }
  }
  if (!current?.conflicts.length && !error) return null
  return <section className="panel account-conflicts" aria-label="Saved version conflicts"><h2>{current?.conflicts.some(value => value.active) ? 'Saved versions need review' : 'Saved version history'}</h2><p>Compare each complete version before choosing. Both originals remain available after your choice.</p>{error && <p role="alert">{error}</p>}<button disabled={busy} onClick={() => setRefresh(value => value + 1)}>Refresh comparison</button>{current?.conflicts.map(({ conflict, versions, active, copyAvailable }) => <article key={conflict.id}><h3>{JSON.parse(conflict.unit.privateKey)[0]} versions</h3>{!active && <p>{conflict.disposition.kind === 'resolved' ? 'Chosen version saved. Both originals are retained.' : 'Earlier comparison. A newer comparison includes later accepted work.'}</p>}<div className="conflict-versions">{versions.map((value, index) => <section key={conflict.branches[index].role}><h4>{index === 0 ? 'Pending version' : 'Accepted version'}</h4><ConflictFileVersion token={token} documents={value.documents} blobs={current.blobs} version={index === 0 ? 'pending' : 'accepted'}/><details><summary>Technical details</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>{active && <button disabled={busy} onClick={() => { void choose(conflict, index === 0 ? 'this' : 'other') }}>{index === 0 ? 'Use pending version' : 'Use accepted version'}</button>}</section>)}</div>{active && copyAvailable && <><p>Keep the accepted Build and copy the pending configuration into a new Build. Both original histories remain available.</p><button disabled={busy} onClick={() => { void choose(conflict, 'both') }}>Keep both configurations</button></>}</article>)}</section>
}
