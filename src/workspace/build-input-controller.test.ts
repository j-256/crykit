import { expect, it } from 'vitest'
import { BuildInputController } from './build-input-controller'

it('carries exact unsaved fields through transfer and rejects old callbacks', () => {
  const controller = new BuildInputController(), view = controller.attach()
  controller.edit(view, 'title', 'Unfinished title ')
  controller.edit(view, 'assumptions', 'line one\n\nline two ')
  controller.edit(view, 'draft', { primaryClass: null, rotationNotes: 'Unfinished notes' })
  controller.dirty(view, true)
  const command = controller.capture(view, () => {})
  command.assertMayActivate()
  const next = controller.transfer(view)
  expect(controller.read(next, 'title', () => '')).toBe('Unfinished title ')
  expect(controller.read(next, 'assumptions', () => '')).toBe('line one\n\nline two ')
  expect(controller.snapshot().dirty).toBe(true)
  expect(() => command.assertMayActivate()).toThrow('retired')
  expect(() => controller.edit(view, 'title', 'stale')).toThrow('retired')
  controller.release(view)
  controller.hydrated(next)
  controller.edit(next, 'title', 'Continued editing')
})
it('requires unchanged input and preserves later edits after strict completion rejection', () => {
  const controller = new BuildInputController(), view = controller.attach()
  controller.edit(view, 'title', 'Captured')
  const command = controller.capture(view, () => {})
  controller.edit(view, 'title', 'Later')
  expect(() => command.assertMayActivate()).toThrow('changed')
  expect(controller.read(view, 'title', () => '')).toBe('Later')
})
it('rechecks unrelated owners and revokes all plaintext on profile change', () => {
  const controller = new BuildInputController(), view = controller.attach()
  controller.edit(view, 'title', 'Private title')
  let blocked = false
  const command = controller.capture(view, () => { if (blocked) throw new Error('Other owner') })
  blocked = true
  expect(() => command.assertMayActivate()).toThrow('Other owner')
  controller.revoke()
  expect(() => command.assertMayActivate()).toThrow('retired')
  expect(controller.read(controller.attach(), 'title', () => '')).toBe('')
})
