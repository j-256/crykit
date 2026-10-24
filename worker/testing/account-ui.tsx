import { createRoot } from 'react-dom/client'
import { AccountView } from '../../src/ui/account/AccountView'
import * as profile from '../../src/account/profile'
import * as store from '../../src/account/device-store'
import { captureEmailCapability } from '../../src/account/email-capability'

// This adapter is built only with the excluded account proof assets, never production
captureEmailCapability()
window.addEventListener('hashchange', () => { if (captureEmailCapability()) window.dispatchEvent(new Event('account-email-link')) })
Object.assign(window, { accountUiProof: {
  async inspect() {
    const token = profile.currentProfileToken()
    const response = await fetch('/api/v1/account')
    const metadata = response.ok ? await response.json() : undefined
    return { token, principal: metadata?.accountId, session: metadata?.sessionId, access: token ? profile.profileAccess(token) : undefined, digest: token ? await profile.withAccountKey(token, async key => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(key)))).join(',')) : undefined }
  },
  cached: store.listCachedProfiles,
} })
createRoot(document.getElementById('root')!).render(<AccountView onOpenWorkspace={async token => { profile.assertActiveProfile(token) }} onContinueLocal={async () => { document.getElementById('root')!.textContent = 'Local continuation selected' }}/>)
