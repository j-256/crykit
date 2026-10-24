import { useState } from 'react'
import { trackProfileUrl, type ProfileToken } from '../../account/profile'

export function RecoveryPanel({ token, missing = true, code, busy, onCreate, onDismiss, onRecover }: { token?: ProfileToken; missing?: boolean; code?: string; busy: boolean; onCreate: () => void; onDismiss?: () => void; onRecover: (email: string, code: string, remember: boolean) => Promise<void> }) {
  const [skipped, setSkipped] = useState(false)
  const [lost, setLost] = useState(false)
  function download() {
    if (!code || !token) return
    const url = URL.createObjectURL(new Blob([code + '\n'], { type: 'text/plain' }))
    trackProfileUrl(token, url)
    const link = document.createElement('a'); link.href = url; link.download = 'crykit-recovery-code.txt'; link.click()
    URL.revokeObjectURL(url)
  }
  return <section><h2>Recovery code</h2><p>Your email cannot unlock your saved data.</p><p>If you forget your password, use your recovery code or an approved device that is still signed in.</p>
    {token ? <>{missing && <p role="status">{skipped ? 'Recovery setup skipped. You still need a recovery code.' : 'You have not saved a recovery code yet.'}</p>}{code && <p><code className="account-code">{code}</code></p>}<button disabled={busy} onClick={code ? download : onCreate}>Download recovery code</button>{code && onDismiss && <button onClick={onDismiss}>Hide recovery code</button>}{!code && <p>Creates a new code. Any previous code stops working.</p>}{missing && <button disabled={busy} onClick={() => setSkipped(true)}>Skip for now</button>}</> : <form onSubmit={event => { event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); const code = String(data.get('code')); (form.elements.namedItem('code') as HTMLInputElement).value = ''; void onRecover(String(data.get('email')), code, data.get('remember') === 'on') }}><label>Recovery email<input aria-label="Recovery email" name="email" type="email" required autoComplete="email"/></label><label>Recovery code<input aria-label="Recovery code" name="code" required autoComplete="off"/></label><label className="account-check"><input name="remember" type="checkbox"/>Remember this device</label><button disabled={busy}>Use recovery code</button></form>}
    <button onClick={() => setLost(!lost)} type="button" aria-expanded={lost}>Lost access?</button>
    {lost && <div><p>Without your password, recovery code or an approved signed-in device, your saved data cannot be unlocked. Email alone cannot recover it.</p><p>Your existing saved data stays in place.</p><button disabled>Start over</button><p>Account deletion and start-over are not available yet.</p></div>}
  </section>
}
