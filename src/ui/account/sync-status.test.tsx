import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SyncStatus } from './SyncStatus'
import type { SyncState } from '../../account/sync/scheduler'
import { CloudServiceNotice } from '../CloudServiceNotice'
import { clearServiceNotice, serviceNoticeRequest } from '../../account/service-notice'
let container: HTMLDivElement, root: Root
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); clearServiceNotice(); container.remove() })
it('explainsTrafficProtectionAndOffersAPrivateSupportReference', async () => {
  serviceNoticeRequest('synthetic').failure(new Response('', { status: 429, headers: { 'retry-after': '90', 'x-crykit-request-id': 'support-reference' } }), 'RATE_LIMITED')
  await act(async () => root.render(<CloudServiceNotice/>))
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('temporarily limited')
  expect(container.textContent).toContain('protect CryKit')
  expect(container.textContent).toContain('keep editing on this device')
  expect(container.querySelector('time')?.dateTime).toBeTruthy()
  const link = container.querySelector<HTMLAnchorElement>('a')!
  expect(link.textContent).toBe('Contact us')
  expect(link.href).toContain('mailto:abuse@crykit.lasers.app')
  expect(new URL(link.href).searchParams.get('body')).toContain('support-reference')
  expect(container.textContent).not.toContain('Saved on this device')
})
it('distinguishesAServiceUsagePauseWithoutGuessingAResetTime', async () => {
  serviceNoticeRequest('synthetic').failure(new Response('', { status: 503 }), 'SERVICE_PAUSED')
  await act(async () => root.render(<CloudServiceNotice/>))
  expect(container.textContent).toContain('Cloud service paused')
  expect(container.textContent).toContain('service usage safeguard')
  expect(container.querySelector('time')).toBeNull()
  expect(container.textContent).not.toContain('Wait a minute')
})
it('distinguishesLocalFailureFromRemotePause', async () => {
  await act(async () => root.render(<SyncStatus localSaveState="saved" syncState="offline" onRetry={() => {}} onReview={() => {}}/>))
  expect(container.textContent).toContain('Saved on this device')
  expect(container.textContent).toContain('Offline with changes waiting')
  await act(async () => root.render(<SyncStatus localSaveState="error" syncState="paused" onRetry={() => {}} onReview={() => {}}/>))
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Save failed')
  expect(container.textContent).not.toContain('Saved on this device')
  expect(container.textContent).toContain('Keep your open draft')
  expect(container.textContent).toContain('Sync paused')
})
it.each<[SyncState, string]>([['synced', 'Synced'], ['syncing', 'Syncing'], ['signin-required', 'Needs sign-in'], ['conflict', 'Conflicting versions'], ['quota', 'Storage full'], ['failed', 'Sync failed'], ['paused', 'Sync paused']])('exposes %s without disabling editing', async (syncState, label) => {
  const retry = vi.fn(), review = vi.fn()
  await act(async () => root.render(<SyncStatus localSaveState="saved" syncState={syncState} onRetry={retry} onReview={review}/>))
  expect(container.textContent).toContain(label)
  expect(container.querySelector('fieldset[disabled]')).toBeNull()
  const button = container.querySelector<HTMLButtonElement>('button')
  if (button) { expect(button.disabled).toBe(false); await act(async () => button.click()); expect(retry.mock.calls.length + review.mock.calls.length).toBe(1) }
})
it.each(['unsaved', 'saving'] as const)('does not claim %s changes are durable because the cloud is synced', async localSaveState => {
  await act(async () => root.render(<SyncStatus localSaveState={localSaveState} syncState="synced" onRetry={() => {}} onReview={() => {}}/>))
  expect(container.textContent).not.toContain('Saved on this device')
  expect(container.textContent).toContain('previously saved changes')
})
