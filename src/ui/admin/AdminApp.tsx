import { useEffect, useMemo, useRef, useState } from 'react'
import type { AdminCommand, AdminReceipt } from '../../account/admin-protocol'
import { AdminClient, adminErrorMessage } from './admin-client'
import { Icon, type IconName } from '../icons'
import { AdminActionDialog } from './AdminActionDialog'
import AdminOverview from './AdminOverview'
import AdminAccounts from './AdminAccounts'
import AdminSharing from './AdminSharing'
import AdminJobs from './AdminJobs'
import AdminSettings from './AdminSettings'
import AdminAccess from './AdminAccess'
import type { ActionOpener } from './admin-view'
import { parseAdminRoute, routeHash, sections, type Section } from './admin-route'
import './admin.css'

const sectionNames: Record<Section, string> = {
  overview: 'Overview',
  accounts: 'Accounts',
  sharing: 'Sharing',
  jobs: 'Jobs and email',
  settings: 'Service settings',
  access: 'Audit and access',
}
const sectionIcons: Record<Section, IconName> = {
  overview: 'layout-grid',
  accounts: 'user',
  sharing: 'sources',
  jobs: 'clock',
  settings: 'settings',
  access: 'shield',
}
export function newAdminId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}
export default function AdminApp({
  client: providedClient,
  environmentLabel = `Service host ${window.location.host}`,
}: {
  client?: AdminClient
  environmentLabel?: string
}) {
  const client = useMemo(() => providedClient ?? new AdminClient(), [providedClient])
  const [route, setRoute] = useState(() => parseAdminRoute(window.location.hash))
  const section = route.section
  const [role, setRole] = useState<'owner' | 'administrator' | null>(null)
  const [sessionPending, setSessionPending] = useState(true)
  const [error, setError] = useState('')
  const [command, setCommand] = useState<AdminCommand | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [lastAction, setLastAction] = useState<AdminReceipt | null>(null)
  const [unresolved, setUnresolved] = useState<Record<string, string>>({})
  const sessionSequence = useRef(0)
  const actionTrigger = useRef<HTMLElement | null>(null)
  useEffect(() => {
    let active = true
    const request = client.session()
    const sequence = ++sessionSequence.current
    request
      .then((session) => {
        if (active && sequence === sessionSequence.current) {
          setRole(session.role)
          setError('')
          setSessionPending(false)
        }
      })
      .catch((reason) => {
        if (active && sequence === sessionSequence.current) {
          setError(adminErrorMessage(reason))
          setSessionPending(false)
        }
      })
    const onHash = () => setRoute(parseAdminRoute(window.location.hash))
    const off = client.onSessionLost(() => {
      sessionSequence.current++
      setRole(null)
      setCommand(null)
      setSessionPending(false)
      setError('Access changed. Sign in again and refresh.')
    })
    window.addEventListener('hashchange', onHash)
    return () => {
      active = false
      off()
      window.removeEventListener('hashchange', onHash)
    }
  }, [client])
  useEffect(() => {
    if (role === 'administrator' && section === 'settings')
      window.location.hash = routeHash('overview')
  }, [role, section])
  const openAction: ActionOpener = (trigger, target, expectedRevision, payload, reason, caseId) => {
    // Pointer clicks need not focus buttons in WebKit, so retain the actual invoker
    actionTrigger.current = trigger
    setLastAction(null)
    setCommand({
      version: 1,
      actionId: newAdminId(),
      target,
      expectedRevision,
      reason,
      ...(caseId ? { caseId } : {}),
      command: payload,
    })
  }
  const completeAction = (receipt: AdminReceipt) => {
    setLastAction(receipt)
    // A hidden in-flight action may finish after its dialog closes; invalidate inspected revisions then
    setRefreshKey((value) => value + 1)
    setUnresolved((previous) => {
      const next = { ...previous }
      delete next[receipt.actionId]
      return next
    })
  }
  const clearAction = (actionId: string) =>
    setUnresolved((previous) => {
      const next = { ...previous }
      delete next[actionId]
      return next
    })
  const checkAction = async (actionId: string) => {
    try {
      completeAction(await client.lookup(actionId))
    } catch (reason) {
      setUnresolved((previous) => ({
        ...previous,
        [actionId]: `Outcome unresolved. ${adminErrorMessage(reason)} Check this action again before repeating it.`,
      }))
    }
  }
  const retrySession = () => {
    setSessionPending(true)
    const request = client.session()
    const sequence = ++sessionSequence.current
    request
      .then((session) => {
        if (sequence === sessionSequence.current) {
          setRole(session.role)
          setError('')
          setSessionPending(false)
        }
      })
      .catch((reason) => {
        if (sequence === sessionSequence.current) {
          setError(adminErrorMessage(reason))
          setSessionPending(false)
        }
      })
  }
  const navigate = (target: Section) => {
    setRoute({ section: target, target: null })
    window.location.hash = routeHash(target)
  }
  // Preserve the route hash while moving keyboard focus to the main landmark
  const skipToMain = (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    document.getElementById('main')?.focus()
  }
  return (
    <div className="admin-shell">
      <a className="admin-skip" href="#main" onClick={skipToMain}>
        Skip to main content
      </a>
      <header className="admin-header">
        <a className="admin-brand" href="/admin/" aria-label="Crystal Kit administration home">
          <Icon name="crystal" />
          <span className="admin-brand__text">
            <strong>Crystal Kit</strong>
            <small>Administration</small>
          </span>
        </a>
        <div className="admin-header__context">
          <span className="admin-environment">
            <Icon name="box" />
            {environmentLabel}
          </span>
          <span className="admin-role">
            <Icon name="shield" />
            {role ? `${role} session` : sessionPending ? 'Checking session' : 'Session unavailable'}
          </span>
        </div>
      </header>
      <div className={`admin-workspace${role ? '' : ' admin-workspace--no-nav'}`}>
        {role && (
          <nav className="admin-nav" aria-label="Administration">
            <span className="admin-nav__eyebrow">Workspace</span>
            {sections
              .filter((item) => role === 'owner' || item !== 'settings')
              .map((item) => (
                <a
                  key={item}
                  href={`#${item}`}
                  title={sectionNames[item]}
                  aria-current={section === item ? 'page' : undefined}
                  onClick={() => navigate(item)}
                >
                  <Icon name={sectionIcons[item]} />
                  <span>{sectionNames[item]}</span>
                </a>
              ))}
          </nav>
        )}
        <main className="admin-main" id="main" tabIndex={-1}>
          {error && (
            <div className="admin-error" role="alert">
              <Icon name="warning" />
              {error}{' '}
              <button type="button" onClick={retrySession}>
                Retry session
              </button>
            </div>
          )}
          {Object.entries(unresolved).map(([actionId, message]) => (
            <div className="admin-error" role="status" key={actionId}>
              <span className="admin-id">Action {actionId}</span>: {message}{' '}
              {role ? (
                <button type="button" onClick={() => void checkAction(actionId)}>
                  Check action status
                </button>
              ) : (
                <span>Sign in again to check its receipt.</span>
              )}
            </div>
          ))}
          {sessionPending && !role && (
            <div className="admin-pending" role="status">
              <Icon name="clock" />
              <div>
                <strong>Loading administrator session</strong>
                <p>Checking access to this service.</p>
              </div>
            </div>
          )}
          {role && (
            <div className="admin-page">
              {section === 'overview' && <AdminOverview client={client} />}
              {section === 'accounts' && (
                <AdminAccounts
                  client={client}
                  openAction={openAction}
                  role={role}
                  routeTarget={route.target}
                  refreshKey={refreshKey}
                />
              )}
              {section === 'sharing' && (
                <AdminSharing
                  client={client}
                  openAction={openAction}
                  routeTarget={route.target}
                  refreshKey={refreshKey}
                />
              )}
              {section === 'jobs' && (
                <AdminJobs
                  client={client}
                  openAction={openAction}
                  routeTarget={route.target}
                  refreshKey={refreshKey}
                />
              )}
              {section === 'settings' && role === 'owner' && (
                <AdminSettings client={client} openAction={openAction} refreshKey={refreshKey} />
              )}
              {section === 'access' && (
                <AdminAccess
                  client={client}
                  role={role}
                  openAction={openAction}
                  newId={newAdminId}
                  refreshKey={refreshKey}
                />
              )}
              {lastAction && (
                <p role="status">
                  Action <span className="admin-id">{lastAction.actionId}</span> accepted:{' '}
                  {lastAction.state}. Inspect the latest detail before another action.
                </p>
              )}
            </div>
          )}
        </main>
      </div>
      {command && role && (
        <AdminActionDialog
          client={client}
          command={command}
          environmentLabel={environmentLabel}
          onClose={() => {
            setCommand(null)
            window.setTimeout(() => {
              const trigger = actionTrigger.current
              if (trigger?.isConnected) trigger.focus()
              else document.querySelector<HTMLElement>('.admin-page h1')?.focus()
            }, 0)
          }}
          onSubmitted={(actionId) =>
            setUnresolved((previous) => ({
              ...previous,
              [actionId]:
                'Request in progress. Hiding this view does not cancel the server action.',
            }))
          }
          onUncertain={(actionId, message) =>
            setUnresolved((previous) => ({ ...previous, [actionId]: message }))
          }
          onDefinitiveFailure={clearAction}
          onComplete={completeAction}
        />
      )}
    </div>
  )
}
