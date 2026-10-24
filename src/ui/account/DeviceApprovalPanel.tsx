import { useEffect, useRef, useState } from 'react'
import * as lifecycle from '../../account/lifecycle'
import * as management from '../../account/management'
import { assertActiveProfile, type ProfileToken } from '../../account/profile'
import type { ApprovalRequest } from '../../account/protocol'

type DevicePage = Awaited<ReturnType<typeof management.readProfileDevices>>
export function DeviceApprovalPanel({ token, busy, run, onAccess }: { token?: ProfileToken; busy: boolean; run: (work: () => Promise<void>) => void; onAccess: (token: ProfileToken) => Promise<void> }) {
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [approval, setApproval] = useState<lifecycle.ApprovalView>()
  const [ready, setReady] = useState(false)
  const [requests, setRequests] = useState<readonly ApprovalRequest[]>([])
  const [moreRequests, setMoreRequests] = useState(false)
  const [page, setPage] = useState<DevicePage>()
  const [compared, setCompared] = useState<string>()
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [])
  // A cached profile can survive navigation; the panel still owns and cancels its pending request
  useEffect(() => () => { if (approval) lifecycle.cancelAccountDeviceApproval(approval.handle) }, [approval])
  async function refresh() {
    if (!token) return
    const [devices, pending] = await Promise.all([management.readProfileDevices(token), management.readProfileApprovals(token)])
    assertActiveProfile(token); setPage(devices); setRequests(pending.requests); setMoreRequests(pending.hasMore); setCompared(undefined)
  }
  if (!token) return <section><h2>Use an approved device</h2><p>Ask a device that is already signed in to approve this one.</p><form onSubmit={event => { event.preventDefault(); const email = String(new FormData(event.currentTarget).get('email')); run(async () => { if (approval) lifecycle.cancelAccountDeviceApproval(approval.handle); setReady(false); const next = await lifecycle.startAccountDeviceApproval(email); if (!mounted.current) { lifecycle.cancelAccountDeviceApproval(next.handle); return } setApproval(next); await lifecycle.waitForAccountDeviceApproval(next.handle); setReady(true) }) }}><label>Account email<input aria-label="Account email" type="email" name="email" required/></label><button disabled={busy}>Request approval</button></form>{approval && <><p>Request ID: <code className="account-code">{approval.requestId}</code></p><p>Compare this code on both devices: <strong>{approval.fingerprint}</strong></p><p>{now >= approval.expiresAt ? 'Request expired. Request approval again.' : 'Approval expires after 10 minutes.'}</p><button onClick={() => { lifecycle.cancelAccountDeviceApproval(approval.handle); setApproval(undefined); setReady(false) }}>Cancel approval</button>{ready && <form onSubmit={event => { event.preventDefault(); const remember = new FormData(event.currentTarget).get('remember') === 'on'; run(async () => onAccess(await lifecycle.completeAccountDeviceApproval(approval.handle, remember))) }}><label className="account-check"><input name="remember" type="checkbox"/>Remember this device</label><button disabled={busy || now >= approval.expiresAt}>Complete approval</button></form>}</>}</section>
  const devices = page ? [...new Map([page.currentDevice, ...page.devices].map(device => [device.id, device])).values()] : []
  return <section><h2>Devices</h2><button disabled={busy} onClick={() => run(refresh)}>Refresh devices and approvals</button><p>Removing a device stops its online access. It cannot erase downloaded copies or prevent someone with your password from signing in again.</p>{devices.map(device => <div key={device.id} className="account-device"><span>{device.id === page?.currentDevice.id ? 'This device' : `Device ending ${device.id.slice(-6)}`} · {new Date(device.createdAt).toLocaleDateString()}{device.revokedAt ? ' · Removed' : ''}</span><button disabled={busy || device.revokedAt !== null} onClick={() => run(async () => { await management.removeProfileDevice(token, device.id); if (device.id === page?.currentDevice.id) await lifecycle.lockProfile(token); else await refresh() })}>Remove {device.id === page?.currentDevice.id ? 'this device' : `device ending ${device.id.slice(-6)}`}</button></div>)}{page?.hasMore && <button disabled={busy} onClick={() => run(async () => { const next = await management.readProfileDevices(token, page.nextCursor ?? undefined); setPage({ ...next, devices: [...page.devices, ...next.devices] }) })}>Load more devices</button>}
    <h3>Approve a device</h3><p>Compare the entire code with the requesting device before approving.</p>{moreRequests && <p>More requests exist. Refresh or find a request by its ID.</p>}
    <form onSubmit={event => { event.preventDefault(); const id = String(new FormData(event.currentTarget).get('requestId')); run(async () => { const request = await management.findProfileApproval(token, id); setRequests([request]); setCompared(undefined) }) }}><label>Request ID<input name="requestId" aria-label="Request ID" required/></label><button disabled={busy}>Find request</button></form>
    {requests.map(request => <div key={request.requestId}><p>Code: <strong>{request.fingerprint}</strong></p><p>{request.expiresAt <= now ? 'Request expired.' : `Expires ${new Date(request.expiresAt).toLocaleTimeString()}`}</p><label className="account-check"><input type="checkbox" checked={compared === request.requestId} onChange={event => setCompared(event.target.checked ? request.requestId : undefined)}/>The codes match on both devices</label><button disabled={busy || compared !== request.requestId || now >= request.expiresAt} onClick={() => run(async () => { await management.approveProfileDevice(token, request, request.fingerprint); await refresh() })}>Approve device</button><button disabled={busy} onClick={() => run(async () => { await management.rejectProfileApproval(token, request.requestId); await refresh() })}>Reject request</button></div>)}
  </section>
}
