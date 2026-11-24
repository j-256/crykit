import { afterEach, expect, it } from 'vitest'
import { observeAccountForeground, waitForAccountForeground } from '../account/background-work'
import { installProfile, invalidateProfile } from '../account/profile'
import { accountLocalId } from '../workspace/account-cache'
import { createEditorSession, releaseEditorAutosaveForeground, transferEditorAutosaveForeground, updateEditorAutosaveForeground } from './editor-session'

const baseline = '{}'

function editor() {
  const session = createEditorSession(), { controller } = session
  const view = controller.attach()
  session.transferView = view
  return { session, controller, view }
}

function account() {
  const token = installProfile(accountLocalId(), new Uint8Array(32)), edges: boolean[] = []
  observeAccountForeground(token, pending => edges.push(pending))
  return { token, edges }
}

afterEach(() => invalidateProfile())

it('queues foreground only for unfinished input and cancels coalesced work at its durable baseline', async () => {
  const { session, controller, view } = editor(), { token, edges } = account()
  updateEditorAutosaveForeground(session, view, token, true)
  controller.open(view, 'synthetic', 1, { original: baseline, applied: baseline, reference: 'reference' }, { text: baseline, editedPath: [], fieldState: null, validation: 'unchecked' })
  controller.rememberFocus(view, { key: 'editor', start: 0, end: 0, direction: 'none' })
  updateEditorAutosaveForeground(session, view, token, true)
  expect(edges).toEqual([false])

  controller.setInteraction(view, 'composition', true)
  controller.editText(view, '{"first":')
  updateEditorAutosaveForeground(session, view, undefined, true)
  expect(edges).toEqual([false])
  updateEditorAutosaveForeground(session, view, token, true)
  let resumed = false
  const waiting = waitForAccountForeground(token).then(() => { resumed = true })
  controller.editText(view, '{"latest":')
  updateEditorAutosaveForeground(session, view, token, true)
  await Promise.resolve()
  expect(resumed).toBe(false)
  expect(edges).toEqual([false, true])
  controller.editText(view, baseline)
  updateEditorAutosaveForeground(session, view, token, true)
  await waiting
  expect(edges).toEqual([false, true, false])
})

it('a delayed clean cancellation cannot release a replacement reservation for the same view', async () => {
  const { session, controller, view } = editor(), { token, edges } = account()
  controller.open(view, 'synthetic', 1, { original: baseline, applied: baseline, reference: 'reference' }, { text: baseline, editedPath: [], fieldState: null, validation: 'unchecked' })
  controller.editText(view, '{"old":')
  updateEditorAutosaveForeground(session, view, token, true)
  controller.editText(view, baseline)
  updateEditorAutosaveForeground(session, view, token, true)
  expect(edges).toEqual([false, true])
  releaseEditorAutosaveForeground(session, view)

  controller.editText(view, '{"replacement":')
  updateEditorAutosaveForeground(session, view, token, true)
  controller.editText(view, baseline)
  await Promise.resolve()
  expect(edges).toEqual([false, true, false, true])
  updateEditorAutosaveForeground(session, view, token, true)
  await waitForAccountForeground(token)
  expect(edges).toEqual([false, true, false, true, false])
})

it('holds the original lease through acknowledgement and hydration when a later edit matched the old baseline', async () => {
  const { session, controller, view } = editor(), { token, edges } = account()
  controller.open(view, 'synthetic', 1, { original: baseline, applied: baseline, reference: 'reference' }, { text: baseline, editedPath: [], fieldState: null, validation: 'unchecked' })
  controller.editText(view, '{"captured":')
  updateEditorAutosaveForeground(session, view, token, true)
  const ticket = controller.capture(view, 'saveUnfinished', () => {})
  session.phase = 'staging'
  controller.editText(view, baseline)
  expect(controller.snapshot().dirty).toBe(false)
  updateEditorAutosaveForeground(session, view, token, true)
  session.phase = 'reconciling'
  controller.acknowledge(ticket, 2)
  expect(controller.snapshot()).toMatchObject({ dirty: true, input: { text: baseline } })
  const next = controller.transfer(view)
  transferEditorAutosaveForeground(session, view, next)
  session.transferView = next
  session.phase = 'hydrating'
  releaseEditorAutosaveForeground(session, ticket.view)
  updateEditorAutosaveForeground(session, view, token, false)
  expect(edges).toEqual([false, true])

  controller.hydrated(next)
  session.phase = 'idle'
  updateEditorAutosaveForeground(session, next, token, true)
  expect(edges).toEqual([false, true])
  controller.discard(next)
  releaseEditorAutosaveForeground(session, next)
  expect(edges).toEqual([false, true, false])
})

it('releases stopped dirty input without rearming while autosave is suppressed', async () => {
  const { session, controller, view } = editor(), { token, edges } = account()
  controller.open(view, 'synthetic', 1, { original: baseline, applied: baseline, reference: 'reference' }, { text: baseline, editedPath: [], fieldState: null, validation: 'unchecked' })
  controller.editText(view, '{"failed":')
  updateEditorAutosaveForeground(session, view, token, true)
  const waiting = waitForAccountForeground(token)
  session.phase = 'recovery'
  releaseEditorAutosaveForeground(session, view)
  await waiting
  controller.editText(view, '{"retained":')
  updateEditorAutosaveForeground(session, view, token, false)
  expect(controller.snapshot()).toMatchObject({ dirty: true, input: { text: '{"retained":' } })
  expect(edges).toEqual([false, true, false])
  session.phase = 'idle'
  updateEditorAutosaveForeground(session, view, token, true)
  expect(edges).toEqual([false, true, false, true])
  releaseEditorAutosaveForeground(session, view)
  controller.revoke()
  session.transferView = undefined
  expect(controller.snapshot().dirty).toBe(false)
  expect(edges).toEqual([false, true, false, true, false])
})

it('releases an unmounted view and ignores its late result after another view attaches', () => {
  const { session, controller, view } = editor(), { token, edges } = account()
  controller.open(view, 'synthetic', 1, { original: baseline, applied: baseline, reference: 'reference' }, { text: baseline, editedPath: [], fieldState: null, validation: 'unchecked' })
  controller.editText(view, '{"old":')
  updateEditorAutosaveForeground(session, view, token, true)
  const ticket = controller.capture(view, 'saveUnfinished', () => {})
  releaseEditorAutosaveForeground(session, view)
  controller.release(view)
  session.transferView = controller.attach()
  const successor = session.transferView
  updateEditorAutosaveForeground(session, successor, token, true)
  releaseEditorAutosaveForeground(session, ticket.view)
  expect(edges).toEqual([false, true, false, true])
  releaseEditorAutosaveForeground(session, successor)
  expect(edges).toEqual([false, true, false, true, false])
})
