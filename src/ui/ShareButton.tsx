import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { LocalData } from '../domain'
import { createPublicSnapshot, createPublicShareUrl, type PublicShareTarget } from '../interchange/public-share'
import { accountTransactionId } from '../account/management'
import { listPublishedSnapshots, publishSnapshot, updatePublishedSnapshot, stopSharing } from '../account/shares-client'
import { onProfileSessionChange, type ProfileToken } from '../account/profile'
import type { WorkspaceRepository } from '../workspace/repository'
import type { OwnShare } from '../account/shares-protocol'
import { useOptionalWorkspace } from './WorkspaceProvider'
import { PUBLIC_SHARE_LIMITS, type PublicSnapshot } from '../interchange/public-share-schema'
import { Button, Field, InlineNotice } from './components'
import { Sheet } from './Sheet'
import { useDefinitionLibrary } from './definitions'

const MAX_SHARE_URL_LENGTH = PUBLIC_SHARE_LIMITS.url

export function ShareButton({ localData, target, disabled = false }: { readonly localData: LocalData; readonly target: PublicShareTarget; readonly disabled?: boolean }) {
  const workspace = useOptionalWorkspace()
  const { catalogs } = useDefinitionLibrary()
  const [open, setOpen] = useState(false)
  const [includeNotes, setIncludeNotes] = useState(false)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'manual'>('idle')
  const inputRef = useRef<HTMLInputElement>(null)
  const capacityId = useId()
  const targetId = target.kind === 'build' ? target.revisionId : ('teamId' in target ? `${target.teamId}:${'teamRevisionId' in target ? target.teamRevisionId : ''}` : target.scenarioId)
  const result = useMemo(() => {
    if (!open) return undefined
    try {
      const snapshot = createPublicSnapshot({ planner: { localData, catalogs } }, target, { includeNotes })
      try { return { snapshot, url: createPublicShareUrl(snapshot, window.location.href) } }
      catch (reason) { return { snapshot, error: reason instanceof Error ? reason.message : 'This snapshot exceeds portable link capacity.' } }
    }
    catch (reason) { return { error: reason instanceof Error ? reason.message : 'This snapshot could not be shared.' } }
  }, [catalogs, includeNotes, localData, open, target.kind, targetId])
  const copy = async () => {
    if (!result?.url) return
    try { await navigator.clipboard.writeText(result.url); setCopyState('copied') }
    catch { setCopyState('manual'); inputRef.current?.focus(); inputRef.current?.select() }
  }
  return <>
    <Button disabled={disabled} onClick={() => { setCopyState('idle'); setIncludeNotes(false); setOpen(true) }} tone="secondary" type="button">{target.kind === 'team' ? 'Share team' : 'Share build'}</Button>
    <Sheet description="Preview the saved snapshot before sharing. Private edits do not change a published version." footer={<><Button onClick={() => setOpen(false)} tone="quiet">Close</Button><Button disabled={!result?.url} onClick={() => void copy()}>{copyState === 'copied' ? 'Copied' : 'Copy link'}</Button></>} onClose={() => setOpen(false)} open={open} title={target.kind === 'team' ? 'Share team' : 'Share build'}>
      <div className="stack">
        <p>Includes saved selections, names, source requirements, and calculation inputs. Private definitions, descriptions, source files, artwork, inventory, and learning are omitted.</p>
        <label className="check-row"><input checked={includeNotes} onChange={event => { setIncludeNotes(event.target.checked); setCopyState('idle') }} type="checkbox"/>Include written notes</label>
        <p className="field__hint">Adds your rotation notes, written assumptions, and checkpoint notes. Definition descriptions are never included.</p>
        {result?.snapshot && <div><h3>Required mods</h3>{result.snapshot.setup.layers.length ? <ul>{result.snapshot.setup.layers.map((layer, index) => <li key={index}>{layer.title} · {layer.catalogRevisionId}</li>)}</ul> : <p>No mod layers captured.</p>}{result.snapshot.receipts.some(receipt => receipt.origin.kind === 'personal') && <p>Matching personal definitions are required for selected custom entries.</p>}</div>}
        {includeNotes && result?.snapshot?.notes && <details open><summary>Notes to be shared</summary>{result.snapshot.notes.checkpoint && <p>{result.snapshot.notes.checkpoint}</p>}{result.snapshot.notes.slots.map((slot, index) => slot && <div key={index}>{slot.rotationNotes && <p>{slot.rotationNotes}</p>}{slot.checkpoint && <p>{slot.checkpoint}</p>}{slot.contextAssumptions.map((note, noteIndex) => <p key={noteIndex}>{note}</p>)}</div>)}</details>}
        {open && workspace?.token && <HostedPublication key={`${workspace.token.accountId}:${workspace.token.generation}`} token={workspace.token} repository={workspace.repository} snapshot={result?.snapshot}/>}
        <p>Portable links cannot be revoked. Copies someone saves remain theirs even after you stop a hosted link.</p>
        {result?.error && <InlineNotice title="Link unavailable" tone="danger">{result.error}</InlineNotice>}
        {result?.url && <>
          <Field label="Share URL"><input onFocus={event => event.currentTarget.select()} readOnly ref={inputRef} value={result.url}/></Field>
          <div className="share-capacity"><label htmlFor={capacityId}>Link length: {result.url.length.toLocaleString()} / {MAX_SHARE_URL_LENGTH.toLocaleString()} characters</label><progress id={capacityId} max={MAX_SHARE_URL_LENGTH} value={result.url.length}/><small>{Math.floor((1 - result.url.length / MAX_SHARE_URL_LENGTH) * 100)}% of the link budget remains. Some messaging apps may limit long links.</small></div>
          <a className="button button--secondary" href={result.url} rel="noopener noreferrer" target="_blank">Open preview</a>
        </>}
        {copyState === 'copied' && <p role="status">Share link copied.</p>}
        {copyState === 'manual' && <InlineNotice title="Copy the selected link">Clipboard access was unavailable. Copy the Share URL above.</InlineNotice>}
      </div>
    </Sheet>
  </>
}


function HostedPublication({ token, repository, snapshot }: { readonly token: ProfileToken; readonly repository: WorkspaceRepository; readonly snapshot?: PublicSnapshot }) {
  const [shares, setShares] = useState<OwnShare[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [selected, setSelected] = useState('')
  const [includeAttribution, setIncludeAttribution] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [retry, setRetry] = useState<(() => Promise<void>)>()
  const controller = useRef(new AbortController())
  const scope = useRef({ token, repository })
  if (scope.current.token !== token || scope.current.repository !== repository) {
    controller.current.abort()
    scope.current = { token, repository }
  }
  const urlRef = useRef<HTMLInputElement>(null)
  const share = shares.find(value => value.shareId === selected)
  const refresh = async (after?: string) => {
    const signal = controller.current.signal
    const result = await listPublishedSnapshots(token, after, signal)
    if (signal.aborted) return
    setShares(old => after ? [...old, ...result.shares] : result.shares)
    setNext(result.next)
  }
  const loadMore = (after: string) => {
    // A cancelled request must not replace the session recovery message, even if a new controller exists
    const signal = controller.current.signal
    void refresh(after).catch(() => { if (!signal.aborted) setError('More links could not be loaded.') })
  }
  useEffect(() => {
    const current = new AbortController()
    controller.current = current
    setShares([]); setSelected(''); setRetry(undefined); setBusy(false)
    // Renewal changes authority even when the same profile and component stay mounted
    const stop = onProfileSessionChange(token, () => { current.abort(); setShares([]); setSelected(''); setRetry(undefined); setError('Account connection changed. Close and reopen sharing to continue.') })
    void refresh().catch(() => { if (!current.signal.aborted) setError('Hosted links could not be loaded. Close and reopen sharing to retry.') })
    return () => { stop(); current.abort() }
  }, [token, repository])
  const perform = async (operation: () => Promise<void>) => {
    const signal = controller.current.signal
    setBusy(true); setError(''); setMessage('')
    try { await operation(); if (!signal.aborted) setRetry(undefined) }
    catch (reason) {
      if (signal.aborted) return
      const code = reason instanceof Error ? reason.message : ''
      const definite = ['HEAD_CONFLICT', 'IDEMPOTENCY_MISMATCH', 'INVALID_REQUEST', 'FORBIDDEN', 'QUOTA_EXCEEDED', 'PAYLOAD_TOO_LARGE'].includes(code)
      const deferred = ['RATE_LIMITED', 'SERVICE_PAUSED'].includes(code)
      setError(deferred ? 'Cloud request paused. See the retry and contact details above, then retry the same request.' : definite ? `Request could not complete (${code}). Close and reopen sharing to refresh the link.` : 'The result is not confirmed. Retry the same request to check completion.')
      setRetry(definite ? undefined : () => operation)
    } finally { if (!signal.aborted) setBusy(false) }
  }
  const publish = () => {
    if (!snapshot) return
    const input = { mutationId: accountTransactionId(), snapshot, includeAttribution }
    const captured = share, signal = controller.current.signal
    void perform(async () => {
      const value = captured ? await updatePublishedSnapshot(token, captured.shareId, { ...input, expectedRevision: captured.revision }, signal) : await publishSnapshot(token, input, signal)
      if (signal.aborted) return
      // Associate only the explicitly chosen link, never a title/content guess or private Build ID
      const row: OwnShare = { ...value, title: input.snapshot.title, kind: input.snapshot.kind, state: 'active', includeAttribution: input.includeAttribution }
      setShares(old => [...old.filter(item => item.shareId !== row.shareId), row]); setSelected(row.shareId)
      setMessage(captured ? 'Shared version updated.' : 'Hosted link published.')
    })
  }
  const stop = () => {
    if (!share) return
    const signal = controller.current.signal
    const captured = share, input = { mutationId: share.stopMutationId ?? accountTransactionId(), expectedRevision: share.stopExpectedRevision ?? share.revision }
    void perform(async () => {
      const value = await stopSharing(token, captured.shareId, input, signal)
      if (signal.aborted) return
      setShares(old => old.map(row => row.shareId === captured.shareId ? { ...row, ...value, state: 'stopped', stopMutationId: undefined, stopExpectedRevision: undefined } : row))
      setMessage('Sharing stopped. This hosted link is unavailable.')
    })
  }
  const copyHosted = async () => {
    if (!share) return
    const signal = controller.current.signal
    try {
      await navigator.clipboard.writeText(share.url)
      if (!signal.aborted) setMessage('Hosted link copied.')
    } catch {
      if (signal.aborted) return
      urlRef.current?.focus(); urlRef.current?.select(); setMessage('Copy the selected Hosted URL.')
    }
  }
  return <section className="stack" aria-label="Hosted publication">
    <h3>Hosted link</h3><p>Unlisted: anyone with the link can view or copy it. Edits stay private until you choose Update shared version. Stop sharing makes this hosted link unavailable.</p>
    <Field label="Published link"><select aria-label="Published link" value={selected} disabled={busy || Boolean(retry)} onChange={event => { setSelected(event.target.value); setIncludeAttribution(false); setMessage(''); setError('') }}><option value="">Create a new hosted link</option>{shares.map(row => <option key={row.shareId} value={row.shareId}>{row.title} · {row.shareId} · {row.state}</option>)}</select></Field>
    {next && <Button disabled={busy} onClick={() => loadMore(next)}>Load more links</Button>}
    <label className="check-row"><input type="checkbox" checked={includeAttribution} disabled={busy || Boolean(retry)} onChange={event => setIncludeAttribution(event.target.checked)}/>Include my public screen name</label>
    <p className="field__hint">Uses your current permitted screen name. Your email and account identity are never included.</p>
    <div className="cluster"><Button disabled={busy || Boolean(retry) || !snapshot || Boolean(share && share.state !== 'active')} onClick={publish}>{share ? 'Update shared version' : 'Share'}</Button>{share && share.state !== 'stopped' && <Button disabled={busy || Boolean(retry)} onClick={stop}>{share.state === 'stopping' ? 'Retry Stop sharing' : 'Stop sharing'}</Button>}{retry && <Button disabled={busy} onClick={() => void perform(retry)}>Retry publication request</Button>}</div>
    {share && <><Field label="Hosted URL"><input readOnly ref={urlRef} value={share.url} onFocus={event => event.currentTarget.select()}/></Field><Button onClick={() => void copyHosted()}>Copy hosted link</Button></>}
    {message && <p role="status">{message}</p>}{error && <InlineNotice title="Hosted publication" tone="warning">{error}</InlineNotice>}
  </section>
}
