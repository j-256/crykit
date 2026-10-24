import { useState, type ReactElement } from 'react'
import { deleteAccount, retryDeletion, canRetryDeletion, deletionConfirmation, forgetDeletionStatus, hasDeletionStatus, readDeletionStatus, type DeletionStatus } from '../../account/deletion'
import type { ProfileToken } from '../../account/profile'

const phases:Record<DeletionStatus['phase'],string>={ledger:'Recording account revocation',fence:'Removing encrypted cloud data',liabilities:'Verifying retained storage fences',transfer:'Releasing account storage',metadata:'Removing account records',envelopes:'Removing encrypted key envelopes',account:'Completing deletion',complete:'Account deletion complete'}

export function DeletionPanel({token,busy}:{token?:ProfileToken;busy:boolean}):ReactElement {
  const [open,setOpen]=useState(false),[confirmation,setConfirmation]=useState(''),[pending,setPending]=useState(hasDeletionStatus)
  const [status,setStatus]=useState<DeletionStatus>(),[working,setWorking]=useState(false),[error,setError]=useState('')
  async function perform(work:()=>Promise<DeletionStatus>) {
    setWorking(true);setError('')
    try {setStatus(await work())} catch(reason) {
      setError(reason instanceof Error && reason.message==='AUTH_REQUIRED' ? 'Sign in again to confirm your identity, then retry deletion.' : 'Deletion is not confirmed. Check progress before starting again.')
    } finally {setPending(hasDeletionStatus());setWorking(false)}
  }
  return <section><h2>Delete account</h2>
    {pending ? <><p role="status">{status?.state==='complete' ? 'Account deletion complete.' : 'Account deletion is pending. Account access and shared links stay blocked once deletion starts.'}</p>{status && <p>{phases[status.phase]}</p>}<button disabled={working} onClick={()=>void perform(readDeletionStatus)}>Check deletion progress</button>{status?.state!=='complete' && <>{canRetryDeletion(token) ? <form onSubmit={event=>{event.preventDefault();if(token)void perform(()=>retryDeletion(token,confirmation))}}><p>If progress is unavailable, retry the original deletion request. Confirm your identity again first if needed.</p><label>Type DELETE MY ACCOUNT<input aria-label="Type DELETE MY ACCOUNT" value={confirmation} onChange={event=>setConfirmation(event.target.value)} autoComplete="off"/></label><button disabled={confirmation!==deletionConfirmation||!token||busy||working}>Retry account deletion</button></form> : <p>Checking progress does not need sign-in. Retrying requires the original account saved with this request; older progress tokens cannot be reassigned.</p>}</>}<p>This tab keeps a private progress token. Deletion continues if you close it. Local copies on your devices and downloaded backups remain.</p>{status?.state==='complete' && <button onClick={()=>{forgetDeletionStatus();setPending(false);setStatus(undefined);setOpen(false)}}>Dismiss deletion status</button>}</> : <>
      <button disabled={!token||busy||working} onClick={()=>setOpen(true)}>Delete account</button>
      {open && <form onSubmit={event=>{event.preventDefault();if(token)void perform(()=>deleteAccount(token,confirmation))}}><p>Delete the account and its encrypted cloud data permanently. Shared links stop working immediately and all devices lose online access. Local copies and downloaded backups remain. Retained service recovery copies expire under the backup retention policy; they cannot reactivate this account.</p><p>Download a private backup first if you need these files. Confirm your identity in Account settings within 10 minutes before deleting.</p><label>Type DELETE MY ACCOUNT<input aria-label="Type DELETE MY ACCOUNT" value={confirmation} onChange={event=>setConfirmation(event.target.value)} autoComplete="off"/></label><button disabled={confirmation!==deletionConfirmation||!token||busy||working}>Permanently delete account</button><button type="button" disabled={working} onClick={()=>{setOpen(false);setConfirmation('')}}>Cancel</button></form>}
    </>}{error && <p role="alert">{error}</p>}{status?.code && <p>Cleanup needs another service attempt. Account access remains blocked. Diagnostic: {status.code}.</p>}</section>
}
