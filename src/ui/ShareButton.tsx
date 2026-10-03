import { useId, useMemo, useRef, useState } from 'react'
import type { LocalData } from '../domain'
import { createSharePayload, createShareUrl, MAX_SHARE_URL_LENGTH, type ShareTarget } from '../interchange/share'
import { Button, Field, InlineNotice } from './components'
import { Sheet } from './Sheet'

export function ShareButton({ localData, target, disabled = false }: { readonly localData: LocalData; readonly target: ShareTarget; readonly disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const [includeNotes, setIncludeNotes] = useState(false)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'manual'>('idle')
  const inputRef = useRef<HTMLInputElement>(null)
  const capacityId = useId()
  const targetId = target.kind === 'build' ? target.revisionId : ('teamId' in target ? target.teamId : target.scenarioId)
  const result = useMemo(() => {
    if (!open) return undefined
    try { return { url: createShareUrl(createSharePayload(localData, target, includeNotes), window.location.href) } }
    catch (reason) { return { error: reason instanceof Error ? reason.message : 'This snapshot could not be shared.' } }
  }, [includeNotes, localData, open, target.kind, targetId])
  const copy = async () => {
    if (!result?.url) return
    try { await navigator.clipboard.writeText(result.url); setCopyState('copied') }
    catch { setCopyState('manual'); inputRef.current?.focus(); inputRef.current?.select() }
  }
  return <>
    <Button disabled={disabled} onClick={() => { setCopyState('idle'); setOpen(true) }} tone="secondary" type="button">{target.kind === 'team' ? 'Share team' : 'Share build'}</Button>
    <Sheet description="Anyone with this link can view the saved snapshot. Further edits need a new link." footer={<><Button onClick={() => setOpen(false)} tone="quiet">Close</Button><Button disabled={!result?.url} onClick={() => void copy()}>{copyState === 'copied' ? 'Copied' : 'Copy link'}</Button></>} onClose={() => setOpen(false)} open={open} title={target.kind === 'team' ? 'Share team' : 'Share build'}>
      <div className="stack">
        <p>The link includes the pinned loadout, calculation inputs, Game Setup, and required personal definitions. Teams use four ordered slots. Character records, inventory, learning, and history stay in this browser.</p>
        <label className="check-row"><input checked={includeNotes} onChange={event => { setIncludeNotes(event.target.checked); setCopyState('idle') }} type="checkbox"/>Include written notes</label>
        <p className="field__hint">Game rules and calculation inputs are always included. This adds rotation notes, written assumptions, and checkpoint names.</p>
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
