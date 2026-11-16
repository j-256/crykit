import { assertActiveProfile, type ProfileToken } from '../../account/profile'
import { createAccountRecoveryService } from '../../workspace/account-recovery'
import { disposeWorkspaceSnapshot } from '../../workspace/snapshot'
import { downloadWorkspaceBackup, requestWorkspaceDownload } from '../download-stream'
import type { RecoveryPoint } from '../../account/recovery-protocol'
import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '../components'
import { Icon, type IconName } from '../icons'
import type { SigninAction, SigninDisplaySummary, SigninPreparationStage, SigninReconciliationState } from '../../workspace/signin-reconciliation'
import './account.css'

interface Actions {
  choose(action: SigninAction): Promise<void>
  confirm(): Promise<void>
  cancel(): Promise<void>
  retry(): Promise<void>
  reviewReplacement(action: 'device' | 'latest'): Promise<void>
  declineReplacement(): Promise<void>
  backup(): Promise<void>
  reconnect?(): Promise<void>
}
const reasons: Record<string, string> = {
  quota: 'Preparation reached a recovery point limit or a storage limit. Pending recovery points stay protected: finish syncing or review pending replacements before retrying. Completed points can be retired when eligible; storage limits also require enough free space. A private backup preserves your data but does not free capacity.',
  'signin-required': 'This account is unlocked locally. Reconnect online access to review current account data. If reconnect fails, return to the workspace and sign in again.',
  offline: 'Fresh account data is unavailable offline. Reconnect to review a merge or replacement. An already admitted account copy can still be opened.',
  'review-stale': 'Account data changed after review. Retry preparation to check the latest data before choosing.',
  'source-changed': 'The source changed after review. Retry preparation before making a new choice.',
  'saved-copy-review-required': 'An earlier saved copy needs review. Open account data, then review saved copies in Account settings.',
  'opening-failed': 'Your saved decision is retained. Retry opening without copying the data again.',
  'replacement-review-required': 'This replacement is paused. Review it explicitly before publishing to other devices.',
}
const recordLabels: Record<string, readonly [string, string]> = {
  build: ['Build', 'Builds'], 'build-checkpoint': ['Build checkpoint', 'Build checkpoints'], progress: ['Progress record', 'Progress records'],
  'workspace-identity': ['workspace record', 'workspace records'], blob: ['file content', 'file contents'], 'blob-reference': ['file reference', 'file references'], change: ['saved change', 'saved changes'],
  'workspace-preferences': ['workspace preference', 'workspace preferences'],
  'personal-definition': ['personal definition', 'personal definitions'],
  playthrough: ['Playthrough', 'Playthroughs'], character: ['Character', 'Characters'],
  goal: ['goal', 'goals'], scenario: ['party plan', 'party plans'], inventory: ['inventory record', 'inventory records'],
  'quintar-breeding': ['Quintar breeding record', 'Quintar breeding records'],
  team: ['Team', 'Teams'], 'team-checkpoint': ['Team checkpoint', 'Team checkpoints'],
  setup: ['Game Setup', 'Game Setups'], catalog: ['catalog', 'catalogs'], source: ['source file', 'source files'],
  evidence: ['source note', 'source notes'], 'import-receipt': ['import receipt', 'import receipts'], history: ['history entry', 'history entries'],
  'skill-layout': ['skill tree layout', 'skill tree layouts'], 'skill-capture': ['skill tree capture', 'skill tree captures'],
  'reference-preferences': ['Reference preference', 'Reference preferences'], 'library-defaults': ['library preference', 'library preferences'],
  editor: ['editor file', 'editor files'], save: ['game save', 'game saves'], asset: ['asset', 'assets'],
  conflict: ['saved comparison', 'saved comparisons'], 'retained-content': ['saved version', 'saved versions'],
}
const countLabel = (count: number, singular: string, plural = `${singular}s`) => `${count} ${count === 1 ? singular : plural}`
function Summary({ title, summary, icon }: { title: string; summary?: SigninDisplaySummary; icon: IconName }) {
  return <section className="signin-summary" aria-label={title}>
    <h2><Icon name={icon}/>{title}</h2>
    {summary ? <>
      <p className="signin-summary-counts">{countLabel(summary.builds, 'Build')} · {countLabel(summary.progress, 'Progress record')} · {countLabel(summary.other, 'other record')}</p>
      {summary.progressByPlaythrough.length > 0 && <ul>{summary.progressByPlaythrough.map(group => <li key={group.playthroughId}>{group.label ?? 'Unnamed Playthrough'}: {countLabel(group.count, 'Progress record')}</li>)}</ul>}
      {summary.otherByKind.length > 0 && <ul>{summary.otherByKind.map(group => <li key={group.kind}>{countLabel(group.count, ...(recordLabels[group.kind] ?? ['other record', 'other records']))}</li>)}</ul>}
    </> : <p>Summary not available. This does not mean the workspace is empty.</p>}
  </section>
}
const PREPARATION_TICK_MS = 1_000
const LONG_PREPARATION_SECONDS = 30
const preparationLabels: Record<SigninPreparationStage, string> = {
  'waiting-for-sync': 'Finishing earlier account activity...',
  'reading-source': 'Reading saved source records...',
  'opening-account': 'Opening saved account data...',
  'syncing-account': 'Checking for account updates...',
  'checking-account': 'Checking account records and retained history...',
  'checking-source': 'Checking source records and retained history...',
  'comparing-records': 'Comparing source and account records...',
  'preparing-review': 'Preparing saved versions for review...',
  'preparing-merge': 'Preparing your confirmed merge...',
}

function PreparationFeedback({ state, title }: { state: SigninReconciliationState; title: string }) {
  const [started] = useState(() => Date.now())
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => setElapsed(Math.max(0, Math.floor((Date.now() - started) / PREPARATION_TICK_MS))), PREPARATION_TICK_MS)
    return () => window.clearInterval(timer)
  }, [started])
  const label = state.stage ? preparationLabels[state.stage] : state.phase === 'inspecting' ? 'Inspecting saved work...' : state.phase === 'preparing' ? 'Preparing account data...' : state.phase === 'committing' ? 'Saving your reviewed choice...' : 'Opening account workspace...'
  // Keep the clock outside the live region and avoid aria-busy ancestors that defer stage announcements
  return <section className="signin-waiting" aria-label="Workspace activity">
    <div className="signin-activity" role="progressbar" aria-label={title}><span/></div>
    <p role="status" aria-atomic="true">{label}</p>
    <p className="signin-elapsed">{elapsed} {elapsed === 1 ? 'second' : 'seconds'} elapsed</p>
    {elapsed >= LONG_PREPARATION_SECONDS && <p className="signin-waiting-help">This is taking longer than expected. The current step is shown above.</p>}
  </section>
}

export function SigninReconciliation({ state, actions, sourceLabel = 'This device', accountName }: { state: SigninReconciliationState; actions: Actions; sourceLabel?: string; accountName?: string }) {
  const [accountConfirmation, setAccountConfirmation] = useState(false)
  const [error, setError] = useState('')
  const heading = useRef<HTMLHeadingElement>(null)
  const backupDescription = useId()
  const recordLabel = (record: { kind: string; key: string }, displayName = state.local?.recordNames?.[record.key]) => {
    const category = recordLabels[record.kind]?.[0] ?? 'saved record'
    const title = category.charAt(0).toUpperCase() + category.slice(1)
    return displayName ? `${title}: ${displayName}` : title
  }
  const conflictLabel = (key: string) => {
    const direct = state.preview?.closure.find(record => record.key === key)
    if (direct) return recordLabel(direct, state.account?.recordNames?.[key] ?? state.local?.recordNames?.[key])
    // Progress disagreements can use the destination key instead of the included source key
    // Only the explicit correspondence grants that association; labels never match identities
    const mapping = state.preview?.signin?.progressMappings.find(mapping => mapping.destinationKey === key)
    const source = mapping && state.preview?.closure.find(record => record.key === mapping.sourceKey && record.kind === 'progress')
    return source ? recordLabel(source, state.account?.recordNames?.[key] ?? state.local?.recordNames?.[source.key]) : 'Saved record'
  }
  const recovery = sourceLabel === 'Recovery snapshot'
  const paused = state.replacement?.state === 'paused'
  const waiting = ['inspecting', 'preparing', 'committing', 'opening'].includes(state.phase)
  const title = waiting ? state.phase === 'opening' ? 'Opening account workspace' : state.phase === 'committing' ? 'Saving your choice' : 'Preparing your workspace' : accountConfirmation ? 'Use account data on this device?' : state.phase === 'confirming' ? state.action === 'merge' ? 'Review your merge' : state.action === 'latest' ? 'Use latest account data?' : 'Replace account data?' : paused ? 'Review paused replacement' : 'Choose what to keep'
  useEffect(() => { heading.current?.focus() }, [title, state.phase])
  async function run(action: () => Promise<void>) {
    setError('')
    try { await action() } catch { setError('The action could not be completed. Saved data stays in place. Retry or return to your workspace.') }
  }
  return <article className="signin-reconciliation">
    <header className="signin-brand"><Icon name="crystal"/>Crystal Kit</header>
    <h1 ref={heading} tabIndex={-1}>{title}</h1>
    {waiting && <PreparationFeedback state={state} title={title}/>}
    {(error || state.phase === 'failed' || state.reason) && <div role="alert" className="account-error"><Icon name="warning"/><p>{error || reasons[state.reason ?? ''] || 'Account preparation could not finish. Retry when connected. Saved data stays in place.'}</p></div>}
    {state.cleanupPending && <p role="status">Remote cleanup is still pending. The retained preparation will be checked when connected.</p>}
    {!waiting && <>
      <p className="signin-intro">Your original device workspace stays on this device. Account changes sync to your other signed-in devices.</p>
      <div className="signin-summaries"><Summary title={sourceLabel} summary={state.local} icon={recovery ? 'history' : 'layout-page'}/><Summary title={accountName ? `Account: ${accountName}` : 'Account'} summary={state.account} icon="user"/></div>
      {accountConfirmation ? <section className="signin-review">
        <p>This device will show account data instead of {sourceLabel.toLowerCase()} records. Those records are not merged or uploaded. {recovery ? 'The recovery point remains available in Account settings.' : 'The original device workspace remains available through Continue using this device.'}</p>
        <div className="signin-confirm"><Button icon="check" onClick={() => void run(() => actions.choose('account'))}>Confirm use account data</Button><Button tone="quiet" icon="arrow-left" onClick={() => setAccountConfirmation(false)}>Back to choices</Button></div>
      </section>
      : state.phase === 'confirming' ? <section className="signin-review">
        {state.action === 'merge' ? <>
          <p>Combine meaningful work, keeping saved versions when records conflict. Progress matches by exact Playthrough identity, never by name.</p>
          {!state.preview?.resumable && <p>This review is held until you confirm. Reloading before confirmation returns to choices.</p>}
          {state.preview && <>
            <h2><Icon name="layers"/>Included records</h2>
            <ul className="signin-records">{state.preview.closure.map(record => <li key={record.key}><Icon name="check"/><span>{recordLabel(record)}</span></li>)}</ul>
            {!!state.preview.signin?.requiredCompanionKeys.length && <p className="signin-companions">Required starter companions are included: {state.preview.closure.filter(record => state.preview!.signin!.requiredCompanionKeys.includes(record.key)).map(record => recordLabel(record)).join(', ')}.</p>}
            {state.preview.conflicts.length > 0 && <section className="signin-conflicts" aria-label="Saved versions to review">
              <h2><Icon name="compare"/>Saved versions to review</h2>
              <p>Account values stay active until you review the saved versions.</p>
              <ul>{state.preview.conflicts.map((conflict, index) => <li key={index}>{conflictLabel(conflict)}: Both versions will be kept.</li>)}</ul>
            </section>}
            {state.preview.problems.map(problem => <p role="alert" key={problem}>{problem}</p>)}
          </>}
        </> : <p>{state.action === 'latest' ? 'Use the latest account data here and retire the paused replacement. A private recovery snapshot preserves displaced work.' : `Replace account data with the reviewed ${paused ? 'retained workspace' : sourceLabel.toLowerCase()} data. This changes what other devices receive. Displaced account data is preserved in an encrypted recovery point before replacement.`}</p>}
        <div className="signin-confirm"><Button icon="check" disabled={!!state.preview?.problems.length} onClick={() => void run(actions.confirm)}>{state.action === 'merge' ? 'Confirm merge' : state.action === 'latest' ? 'Confirm use latest account data' : 'Confirm replace account data'}</Button></div>
      </section> : paused ? <section className="signin-review">
        <p>Sync is paused because account data changed. Keep working on this device without publishing the replacement, or explicitly review which data to use.</p>
        <div className="signin-confirm"><Button icon="layout-page" onClick={() => void run(actions.declineReplacement)}>Keep working on this device</Button><Button tone="secondary" icon="compare" onClick={() => void run(() => actions.reviewReplacement('device'))}>Review this device replacement</Button><Button tone="secondary" icon="refresh" onClick={() => void run(() => actions.reviewReplacement('latest'))}>Review latest account data</Button></div>
      </section> : <section aria-label="Data choices" className="signin-choices">
        <div className="signin-choice signin-choice--recommended"><Button icon="layers" disabled={!state.fresh || state.source !== 'available'} onClick={() => void run(() => actions.choose('merge'))}>Merge (recommended)</Button><p>Keep meaningful work from both places and preserve conflicting versions for review.</p></div>
        <div className="signin-choice"><Button tone="secondary" icon="user" disabled={!state.canOpenAccount} onClick={() => setAccountConfirmation(true)}>Use account data on this device</Button><p>Show account data here; leave the original device workspace unchanged.</p></div>
        <div className="signin-choice"><Button tone="secondary" icon="upload" disabled={!state.fresh || state.source !== 'available'} onClick={() => void run(() => actions.choose('device'))}>{recovery ? 'Replace account data with recovery data' : "Replace account data with this device's data"}</Button><p>Replace account data across devices after a separate confirmation and recovery snapshot.</p></div>
      </section>}
      <div className="signin-followup">
        {(state.phase === 'failed' || state.reason === 'signin-required') && actions.reconnect && <Button tone="secondary" icon="refresh" onClick={() => void run(actions.reconnect!)}>Reconnect to review</Button>}
        {state.phase === 'failed' && <Button tone="secondary" icon="refresh" onClick={() => void run(actions.retry)}>{state.reason === 'opening-failed' ? 'Retry opening' : 'Retry preparation'}</Button>}
      </div>
    </>}
    <footer className="signin-footer">
      {!waiting && state.canOpenAccount && <div className="signin-backup"><Button tone="quiet" icon="download" aria-describedby={backupDescription} onClick={() => void run(actions.backup)}>Download private account backup</Button><p id={backupDescription}>Includes saved records, imported files, and retained history. The downloaded file is not encrypted.</p></div>}
      {state.phase !== 'opening' && state.phase !== 'committing' && <Button tone="quiet" icon="arrow-left" onClick={() => void run(actions.cancel)}>Cancel and return to workspace</Button>}
    </footer>
  </article>
}


export function AccountRecoveryPoints({ token, onReconcile }: { token: ProfileToken; onReconcile(pointId: string): Promise<void> }) {
  const [points, setPoints] = useState<readonly RecoveryPoint[]>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const live = useRef(true)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [token])
  async function run(action: () => Promise<void>) {
    setBusy(true); setError('')
    try { await action() } catch { if (live.current) setError('Recovery data could not be read. Reconnect and retry. Your saved work stays in place.') }
    finally { if (live.current) setBusy(false) }
  }
  return <section aria-label="Account recovery points"><h2>Recovery points</h2><p>Encrypted snapshots preserve displaced account work. Download a private backup or start a fresh review before bringing records back into your account.</p><button disabled={busy} onClick={() => void run(async () => { const result = await createAccountRecoveryService(token).list(); assertActiveProfile(token); if (live.current) setPoints(result) })}>Refresh recovery points</button>{busy && <p role="status">Reading recovery data...</p>}{error && <p role="alert">{error}</p>}{points?.length === 0 && <p>No retained recovery points were reported by the account service.</p>}{points?.map(point => <div key={point.operationId} className="account-recovery-point"><h3>Recovery from {new Date(point.createdAt).toLocaleString()}</h3><p>{point.sealed ? 'Ready for private recovery' : 'Preparation is incomplete'} · {point.expiresAt ? `Expires ${new Date(point.expiresAt).toLocaleString()}; may be removed earlier to make room` : 'Protected while replacement is pending'}</p><button disabled={busy || !point.sealed} onClick={() => { const destination = requestWorkspaceDownload(); void run(async () => { const sink = await destination; let snapshot; try { snapshot = await createAccountRecoveryService(token).capture(point.operationId); await downloadWorkspaceBackup(snapshot, Promise.resolve(sink)) } catch (error) { await sink?.abort(error).catch(() => {}); throw error } finally { if (snapshot) await disposeWorkspaceSnapshot(snapshot) } }) }}>Download recovery backup</button><button disabled={busy || !point.sealed} onClick={() => void run(() => onReconcile(point.operationId))}>Review recovery data</button></div>)}</section>
}
