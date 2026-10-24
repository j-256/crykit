import { expect, it } from 'vitest'
import { SaveInputController, emptySavePending, savePendingJson } from './save-input-controller'
const base = { original: 'original', working: 'working', requirements: '[]', coverage: 'supported', marker: 'null', context: 'native' }
it('coalesces input returned to its durable pending form without restoring strict command authority', () => {
  const controller = new SaveInputController(), view = controller.attach()
  const input = emptySavePending()
  controller.open(view, 'save', 1, base, new Uint8Array([1]), input)
  const strict = controller.capture(view, 'saveApply', () => {})
  controller.editField(view, 'currency', '7')
  controller.editField(view, 'currency', undefined)
  expect(savePendingJson(controller.snapshot().input!)).toEqual(savePendingJson(input))
  expect(controller.snapshot().dirty).toBe(false)
  expect(() => strict.command.assertMayActivate()).toThrow()
})
it('acknowledges a returned pending form while retaining genuinely later input', () => {
  const controller = new SaveInputController(), view = controller.attach()
  controller.open(view, 'save', 1, base, new Uint8Array([1]), emptySavePending())
  controller.editField(view, 'currency', '7')
  const pending = controller.capture(view, 'savePending', () => {})
  controller.editField(view, 'currency', '8')
  controller.editField(view, 'currency', '7')
  controller.acknowledge(pending, 2)
  expect(controller.snapshot()).toMatchObject({ dirty: false, revision: 2, input: { fields: { currency: '7' } } })
  controller.editField(view, 'currency', '9')
  expect(controller.snapshot()).toMatchObject({ dirty: true, input: { fields: { currency: '9' } } })
})
it('acknowledges immutable pending V while retaining field descendant V+1', () => {
  const controller = new SaveInputController(), view = controller.attach()
  controller.open(view, 'save', 1, base, new Uint8Array([1]), emptySavePending())
  controller.editField(view, 'currency', 'not a number')
  const ticket = controller.capture(view, 'savePending', () => {})
  controller.editField(view, 'currency', '-')
  ticket.command.assertMayActivate()
  controller.acknowledge(ticket, 2)
  expect(ticket.input?.fields.currency).toBe('not a number')
  expect(controller.snapshot().input?.fields.currency).toBe('-')
  expect(controller.snapshot().dirty).toBe(true)
  expect(() => ticket.command.assertSaveInput?.('save', 1, { bytes: new Uint8Array([2]), pendingForm: savePendingJson(ticket.input!) })).toThrow()
})
it('strict Apply and marker reject typing, including same-value reversion', () => {
  for (const operation of ['saveApply', 'saveExport'] as const) {
    const controller = new SaveInputController(), view = controller.attach()
    controller.open(view, 'save', 1, base, new Uint8Array([1]), emptySavePending())
    const ticket = controller.capture(view, operation, () => {})
    controller.editField(view, 'currency', 'x'); controller.editField(view, 'currency', undefined)
    expect(() => ticket.command.assertMayActivate()).toThrow()
  }
})
it('member switch and disposed child cannot manufacture pending descendants', () => {
  const controller = new SaveInputController(), view = controller.attach()
  controller.open(view, 'save', 1, base, new Uint8Array([1]), emptySavePending())
  const child = controller.attachChild(view, 0), ticket = controller.capture(view, 'savePending', () => {})
  controller.selectMember(view, 1)
  expect(() => ticket.command.assertMayActivate()).toThrow()
  expect(() => controller.editClass(view, child, 'primaryClass', null)).toThrow()
})
it('composition defers transfer and old callbacks cannot edit hydrated successor', async () => {
  const controller = new SaveInputController(), view = controller.attach()
  controller.open(view, 'save', 1, base, new Uint8Array([1]), emptySavePending())
  controller.setInteraction(view, 'composition', true)
  expect(() => controller.transfer(view)).toThrow()
  controller.setInteraction(view, 'composition', false)
  const next = controller.transfer(view)
  expect(() => controller.editField(view, 'currency', 'stale')).toThrow()
  controller.editField(next, 'currency', 'during hydration')
  controller.hydrated(next)
  expect(controller.snapshot().input?.fields.currency).toBe('during hydration')
})
it('loadout initialization cannot redefine the durable discard target after member selection', () => {
  const controller = new SaveInputController(), view = controller.attach()
  const loadout = { primaryClass: null, secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [] }
  controller.open(view, 'save', 1, base, new Uint8Array([1]), emptySavePending())
  controller.editField(view, 'currency', 'unsaved')
  controller.selectMember(view, 1)
  const child = controller.attachChild(view, 1)
  controller.initializeLoadout(view, child, loadout, { exact: 'native' })
  controller.discard(view)
  expect(controller.snapshot().input!.fields).toEqual({})
  expect(controller.snapshot().input!.member).toBe(0)
})
it('a source-context transition is strict even when pending fields return to their captured value', () => {
  const controller = new SaveInputController(), view = controller.attach()
  controller.open(view, 'save', 1, base, new Uint8Array([1]), emptySavePending())
  const ticket = controller.capture(view, 'savePending', () => {})
  controller.changeContext(view)
  expect(() => ticket.command.assertMayActivate()).toThrow()
})
it('rejects arbitrary class references and immutable Build snapshots outside the captured child context', () => {
  const controller = new SaveInputController(), view = controller.attach()
  const loadout = { primaryClass: null, secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [] }
  controller.open(view, 'save', 1, base, new Uint8Array([1]), emptySavePending())
  const child = controller.attachChild(view, 0)
  controller.initializeLoadout(view, child, loadout, { exact: 'native' })
  const ref = { kind: 'personal' as const, definitionId: 'unrelated' as import('../domain/types').PersonalDefinitionId }
  expect(() => controller.editClass(view, child, 'primaryClass', ref)).toThrow(/context|selection/)
  expect(() => controller.selectBuild(view, child, { title: 'Unverified', revision: { id: 'unknown', content: loadout } as never, context: null })).toThrow(/context|Build/)
})
it('admits only exact captured child choices as pending descendants and rejects family substitution', () => {
  const controller = new SaveInputController(), view = controller.attach(), context = { native: 'exact' }
  const job = { kind: 'catalog' as const, catalogId: 'native' as never, catalogRevisionId: 'exact' as never, entityId: 'job:1' as never }
  const item = { ...job, entityId: 'item:1' as never }, passive = { ...job, entityId: 'passive:1' as never }
  const loadout = { primaryClass: job, secondaryClass: null, equipment: { hand: null }, passives: [], contextAssumptions: [] }
  controller.open(view, 'save', 1, base, new Uint8Array([1]), emptySavePending())
  const child = controller.attachChild(view, 0)
  controller.initializeLoadout(view, child, loadout, context)
  controller.bindChoices(view, child, context, [{ ref: job, family: 'job' }, { ref: item, family: 'equipment' }, { ref: passive, family: 'passive' }], [])
  const ticket = controller.capture(view, 'savePending', () => {})
  controller.editEquipment(view, child, 'hand', item)
  controller.editPassive(view, child, 0, passive)
  expect(() => ticket.command.assertMayActivate()).not.toThrow()
  expect(ticket.input!.loadout!.equipment.hand).toBeNull()
  expect(controller.snapshot().input!.loadout!.equipment.hand).toEqual({ ref: item })
  expect(() => controller.editClass(view, child, 'primaryClass', item)).toThrow(/context/)
  controller.bindChoices(view, child, context, [{ ref: job, family: 'job' }], [])
  expect(() => ticket.command.assertMayActivate()).toThrow()
})
it('discarding a loadout cannot rebind numeric fields to different source context', () => {
  const controller = new SaveInputController(), view = controller.attach()
  const loadout = { primaryClass: null, secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [] }
  controller.open(view, 'save', 1, base, new Uint8Array([1]), { ...emptySavePending(), fields: { currency: 'recorded value' }, loadout, context: { source: 'original' } })
  const child = controller.attachChild(view, 0)
  expect(() => controller.resetLoadout(view, child, loadout, { source: 'different' })).toThrow(/context/)
  expect(controller.snapshot().input).toMatchObject({ fields: { currency: 'recorded value' }, context: { source: 'original' } })
})
it('persisted JSON key order preserves exact context and choice authority while changed values retire it', () => {
  const controller = new SaveInputController(), view = controller.attach()
  const loadout = { primaryClass: null, secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [] }
  const context = { source: { id: 'native', revision: 'exact' }, values: [1, 2] }
  const reordered = { values: [1, 2], source: { revision: 'exact', id: 'native' } }
  controller.open(view, 'save', 1, base, new Uint8Array([1]), { ...emptySavePending(), context })
  const child = controller.attachChild(view, 0)
  controller.initializeLoadout(view, child, loadout, context)
  controller.bindChoices(view, child, context, [], [])
  const ticket = controller.capture(view, 'savePending', () => {})
  expect(controller.initializeContext(view, reordered)).toBe(true)
  controller.bindChoices(view, child, reordered, [], [])
  expect(() => ticket.command.assertMayActivate()).not.toThrow()
  expect(() => controller.resetLoadout(view, child, loadout, reordered)).not.toThrow()
  expect(controller.initializeContext(view, { ...context, values: [2, 1] })).toBe(false)
  expect(controller.initializeContext(view, { ...context, source: { ...context.source, revision: 'newer' } })).toBe(false)
  expect(() => controller.resetLoadout(view, child, loadout, { ...context, extra: 'unknown' })).toThrow(/context/)
})

it.each(['mounted', 'released'] as const)('profile revoke scrubs all owned plaintext and wakes retired %s input', async state => {
  const controller = new SaveInputController(), view = controller.attach()
  const input = { ...emptySavePending(), fields: { currency: 'private input' }, context: { private: 'definition evidence' } }
  controller.open(view, 'private-save', 1, base, new Uint8Array([19, 23]), input)
  const child = controller.attachChild(view, 0)
  controller.bindChoices(view, child, input.context, [], [])
  const ownedBytes = Reflect.get(controller, 'bytes') as Uint8Array
  const ticket = controller.capture(view, 'savePending', () => {})
  if (state === 'released') {
    controller.release(view)
    expect(controller.snapshot().input).toEqual(input)
    expect(Array.from(ownedBytes)).toEqual([19, 23])
  } else controller.setInteraction(view, 'composition', true)
  const idle = controller.waitForTransfer()
  controller.revoke()
  await idle
  expect(controller.snapshot()).toEqual({ dirty: false })
  for (const key of ['saved', 'base', 'bytes', 'choices', 'child', 'view']) expect(Reflect.get(controller, key), key).toBeUndefined()
  expect(Array.from(ownedBytes)).toEqual([0, 0])
  expect(() => ticket.command.assertMayActivate()).toThrow()
  expect(() => controller.acknowledge(ticket, 2)).toThrow()
  const next = controller.attach()
  expect(controller.snapshot()).toEqual({ dirty: false })
  expect(() => controller.discard(next)).not.toThrow()
  expect(controller.snapshot().input).toBeUndefined()
})
