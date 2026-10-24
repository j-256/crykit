import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { WorkspaceProvider } from './ui/WorkspaceProvider'
import { ErrorBoundary } from './ui/ErrorBoundary'
import './styles.css'
import { captureEmailCapability } from './account/email-capability'

// Strip email capabilities before route state, rendering or history observers can retain them
captureEmailCapability()
window.addEventListener('hashchange', () => {
  if (captureEmailCapability()) window.dispatchEvent(new Event('account-email-link'))
})

// React's default caught-error reporter includes arbitrary Error text; keep private render failures payload-free
createRoot(document.getElementById('root')!, { onCaughtError: () => {}, onUncaughtError: () => console.error('crykit_render_failure', { code: 'UNCAUGHT_RENDER_FAILURE' }) }).render(<StrictMode><ErrorBoundary><WorkspaceProvider><App/></WorkspaceProvider></ErrorBoundary></StrictMode>)
