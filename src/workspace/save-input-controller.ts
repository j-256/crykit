import { jsonEqual } from '../persistence/local-data'
import { guestPlannerValuesEqual } from '../persistence/guest-planner-equality'
import { entityDefinitionKey } from '../domain/core'
import type { BuildRevision, BuildRevisionContent, EntityRef, JsonValue } from '../domain/types'
import type { SaveEditCommand } from '../domain/save-editor'
import { newOwnedFileCommand, type OwnedFileCommand } from './owned-file-command'
import type { SaveOperation } from './save-repository'

export interface SaveFocus { readonly key: string; readonly start: number | null; readonly end: number | null; readonly direction: 'forward' | 'backward' | 'none' | null }
export interface SavePending {
  readonly version: 1
  readonly fields: Readonly<Record<string, string>>
  readonly member: number
  readonly loadout?: BuildRevisionContent
  readonly selectedBuild?: { readonly title: string; readonly revision: BuildRevision; readonly context: JsonValue }
  readonly review?: { readonly title: string; readonly command: SaveEditCommand | { readonly type: 'vanilla' }; readonly timestamp: string; readonly base: string; readonly context: JsonValue; readonly changes: readonly string[]; readonly additions?: readonly string[] }
  readonly context?: JsonValue
  readonly presentation: Readonly<Record<string, JsonValue>>
  readonly focus?: SaveFocus
}
export const emptySavePending = (): SavePending => ({ version: 1, fields: {}, member: 0, presentation: {} })
export function savePendingJson(input: SavePending): JsonValue { return JSON.parse(JSON.stringify(input)) as JsonValue }
// Absent and undefined optional fields persist identically; retain every other key for exact comparison
// A shallow normalization avoids serializing and cloning the complete form on each keystroke
const comparablePending = (input: SavePending | undefined) => input && {
  ...input,
  loadout: input.loadout,
  selectedBuild: input.selectedBuild,
  review: input.review,
  context: input.context,
  focus: input.focus,
}
function frozen<T>(value: T): T {
  const copy = structuredClone(value), stack: unknown[] = [copy]
  while (stack.length) { const item = stack.pop(); if (item && typeof item === 'object') { stack.push(...Object.values(item)); Object.freeze(item) } }
  return copy
}
export interface SaveViewIncarnation { readonly id: symbol }
export interface SaveChildIncarnation { readonly id: symbol; readonly member: number }
export interface SaveContentBase { readonly original: string; readonly working: string; readonly requirements: string; readonly coverage: string; readonly marker: string; readonly context: string }
export interface SaveInputSnapshot { readonly documentId?: string; readonly revision?: number; readonly input?: SavePending; readonly dirty: boolean; readonly focus?: SaveFocus }
export interface SaveInputTicket { readonly command: OwnedFileCommand; readonly input?: SavePending; readonly documentId?: string; readonly revision?: number; readonly version: number }
export class SaveInputController {
  readonly owner = Symbol('save-input-owner')
  private view?: SaveViewIncarnation
  private child?: SaveChildIncarnation
  private choices?: { readonly child: SaveChildIncarnation; readonly identity: readonly unknown[]; readonly refs: ReadonlyMap<string, 'job' | 'equipment' | 'passive'>; readonly builds: readonly NonNullable<SavePending['selectedBuild']>[] }
  private epoch = 0
  private version = 0
  private durable = 0
  private base?: SaveContentBase
  private bytes?: Uint8Array
  private current: SaveInputSnapshot = { dirty: false }
  private saved?: SavePending
  private composition = false
  private gesture = false
  private hydrating = false
  private readonly idleWaiters = new Set<() => void>()
  private tickets = new WeakMap<SaveInputTicket, { readonly version: number }>()
  snapshot(): SaveInputSnapshot { return Object.freeze(this.current) }
  attach(): SaveViewIncarnation {
    if (this.view) throw new Error('The Save input already has a live owner')
    return this.view = Object.freeze({ id: Symbol('save-view') })
  }
  assertView(view: SaveViewIncarnation): void { if (view !== this.view) throw new Error('This Save view was retired') }
  open(view: SaveViewIncarnation, documentId: string, revision: number, base: SaveContentBase, bytes: Uint8Array, input: SavePending): void {
    this.assertView(view); this.epoch++; this.version++; this.durable = this.version; this.child = undefined
    const ownedBytes = bytes.slice()
    this.bytes?.fill(0); this.base = frozen(base); this.bytes = ownedBytes; this.saved = frozen(input)
    this.current = { documentId, revision, input: frozen(input), dirty: false, focus: this.current.documentId === documentId ? this.current.focus : input.focus }
  }
  private edit(view: SaveViewIncarnation, input: SavePending): void {
    this.assertView(view)
    if (!this.current.input) throw new Error('Open a Save before editing')
    this.version++
    const next = frozen({ ...input, focus: this.current.focus ?? input.focus })
    // Exact reversion cancels redundant pending saves while ancestry still invalidates strict commands
    this.current = { ...this.current, input: next, dirty: this.version !== this.durable && !guestPlannerValuesEqual(comparablePending(next), comparablePending(this.saved)) }
  }
  editField(view: SaveViewIncarnation, key: string, value: string | undefined): void {
    if (!/^(currency|member\.\d+\.(name|level|jobId|subJobId)|stock\.(?:item|equipment)\.\d+)$/.test(key)) throw new Error('Unsupported Save field')
    const fields = { ...this.current.input!.fields }
    if (value === undefined) delete fields[key]; else fields[key] = value
    this.edit(view, { ...this.current.input!, fields })
  }
  attachChild(view: SaveViewIncarnation, member: number): SaveChildIncarnation {
    this.assertView(view)
    if (member !== this.current.input?.member) throw new Error('Save member changed')
    if (this.child) throw new Error('Save child already attached')
    return this.child = Object.freeze({ id: Symbol('save-child'), member })
  }
  releaseChild(view: SaveViewIncarnation, child: SaveChildIncarnation): void {
    if (view === this.view && child === this.child) { this.child = undefined; this.epoch++ }
  }
  assertChild(view: SaveViewIncarnation, child: SaveChildIncarnation): void { this.assertView(view); if (this.child !== child || child.member !== this.current.input?.member) throw new Error('This Save child was retired') }
  initializeContext(view: SaveViewIncarnation, context: JsonValue): boolean {
    this.assertView(view)
    const input = this.current.input
    if (!input) return false
    if (input.context !== undefined) return jsonEqual(input.context, context)
    // Missing association evidence on restored choices is unavailable, never inferred from matching IDs
    if (Object.keys(input.fields).length || input.loadout || input.selectedBuild || input.review) return false
    this.epoch++; this.current = { ...this.current, input: frozen({ ...input, context }) }
    if (!this.current.dirty) this.saved = this.current.input
    return true
  }
  initializeLoadout(view: SaveViewIncarnation, child: SaveChildIncarnation, loadout: BuildRevisionContent, context: JsonValue): void {
    this.assertChild(view, child)
    if (this.current.input?.loadout || !this.initializeContext(view, context)) return
    // Initialization fixes the context epoch; it cannot become an admitted descendant of an in-flight command
    this.epoch++; this.current = { ...this.current, input: frozen({ ...this.current.input!, loadout, context }) }
    if (!this.current.dirty) this.saved = this.current.input
  }
  bindChoices(view: SaveViewIncarnation, child: SaveChildIncarnation, context: JsonValue, refs: readonly { readonly ref: EntityRef; readonly family: 'job' | 'equipment' | 'passive' }[], builds: readonly NonNullable<SavePending['selectedBuild']>[]): void {
    this.assertChild(view, child)
    if (!jsonEqual(this.current.input?.context, context)) return
    // Schema parsing may reorder object keys without changing exact persisted context or choice values
    const identity = [context, refs, builds]
    if (this.choices?.child === child && jsonEqual(this.choices.identity, identity)) return
    this.epoch++
    this.choices = { child, identity: frozen(identity), refs: new Map(refs.map(value => [entityDefinitionKey(value.ref), value.family])), builds: frozen(builds) }
  }
  private assertSelection(child: SaveChildIncarnation, ref: EntityRef | null, family: 'job' | 'equipment' | 'passive'): void {
    if (ref && (this.choices?.child !== child || this.choices.refs.get(entityDefinitionKey(ref)) !== family)) throw new Error('Selection is outside the exact Save context')
  }
  changeContext(view: SaveViewIncarnation): void { this.assertView(view); this.epoch++ }
  editClass(view: SaveViewIncarnation, child: SaveChildIncarnation, key: 'primaryClass' | 'secondaryClass', ref: EntityRef | null): void {
    this.assertChild(view, child)
    const loadout = this.current.input?.loadout
    if (!loadout) throw new Error('Exact loadout context is unavailable')
    this.assertSelection(child, ref, 'job')
    const secondaryClass = key === 'primaryClass' && ref && loadout.secondaryClass && entityDefinitionKey(ref) === entityDefinitionKey(loadout.secondaryClass) ? null : loadout.secondaryClass
    this.edit(view, { ...this.current.input!, loadout: { ...loadout, secondaryClass, [key]: ref }, selectedBuild: undefined })
  }
  editEquipment(view: SaveViewIncarnation, child: SaveChildIncarnation, slot: string, ref: EntityRef | null): void {
    this.assertChild(view, child)
    const loadout = this.current.input?.loadout
    if (!loadout || !Object.hasOwn(loadout.equipment, slot)) throw new Error('Unknown equipment slot')
    this.assertSelection(child, ref, 'equipment')
    this.edit(view, { ...this.current.input!, loadout: { ...loadout, equipment: { ...loadout.equipment, [slot]: ref ? { ref } : null } }, selectedBuild: undefined })
  }
  editPassive(view: SaveViewIncarnation, child: SaveChildIncarnation, index: number, ref: EntityRef | null): void {
    this.assertChild(view, child)
    const loadout = this.current.input?.loadout
    if (!loadout || !Number.isInteger(index) || index < 0 || index > loadout.passives.length) throw new Error('Unknown passive slot')
    this.assertSelection(child, ref, 'passive')
    const passives = [...loadout.passives]
    if (ref) passives[index] = { ref }; else passives.splice(index, 1)
    this.edit(view, { ...this.current.input!, loadout: { ...loadout, passives }, selectedBuild: undefined })
  }
  selectBuild(view: SaveViewIncarnation, child: SaveChildIncarnation, selectedBuild: SavePending['selectedBuild']): void { this.assertChild(view, child); if (selectedBuild && (this.choices?.child !== child || !this.choices.builds.some(value => jsonEqual(value, selectedBuild)))) throw new Error('Build is outside the exact Save context'); this.edit(view, { ...this.current.input!, selectedBuild }) }
  present(view: SaveViewIncarnation, key: string, value: JsonValue): void {
    if (!['query', 'inventoryKind', 'stockFilter', 'inventoryLimit', 'picker', 'selected', 'inspectClassPermissions'].includes(key)) throw new Error('Unsupported Save presentation')
    this.assertView(view)
    if (jsonEqual(this.current.input?.presentation[key], value)) return
    this.edit(view, { ...this.current.input!, presentation: { ...this.current.input!.presentation, [key]: value } })
  }
  // Live caret moves are volatile transfer state; a content edit snapshots focus into its versioned pending payload
  rememberFocus(view: SaveViewIncarnation, focus: SaveFocus | undefined): void { this.assertView(view); this.current = { ...this.current, focus: frozen(focus) } }
  discardFields(view: SaveViewIncarnation): void { this.assertView(view); this.epoch++; this.edit(view, { ...this.current.input!, fields: {} }) }
  resetLoadout(view: SaveViewIncarnation, child: SaveChildIncarnation, loadout: BuildRevisionContent, context: JsonValue): void { this.assertChild(view, child); if (!jsonEqual(this.current.input?.context, context)) throw new Error('Recorded Save context is unavailable'); this.epoch++; this.edit(view, { ...this.current.input!, loadout, context, selectedBuild: undefined, review: undefined }) }
  selectMember(view: SaveViewIncarnation, member: number): void {
    this.assertView(view); this.epoch++; this.child = undefined
    this.edit(view, { ...this.current.input!, member, loadout: undefined, selectedBuild: undefined, review: undefined })
  }
  setReview(view: SaveViewIncarnation, review: SavePending['review']): void { this.assertView(view); this.epoch++; this.edit(view, { ...this.current.input!, review }) }
  setInteraction(view: SaveViewIncarnation, kind: 'composition' | 'gesture', active: boolean): void {
    this.assertView(view); if (kind === 'composition') this.composition = active; else this.gesture = active
    if (this.canTransfer()) { for (const resolve of this.idleWaiters) resolve(); this.idleWaiters.clear() }
  }
  canTransfer(): boolean { return !this.composition && !this.gesture }
  async waitForTransfer(): Promise<void> { if (!this.canTransfer()) await new Promise<void>(resolve => this.idleWaiters.add(resolve)) }
  capture(view: SaveViewIncarnation, operation: SaveOperation, barriers: () => void): SaveInputTicket {
    this.assertView(view)
    if (this.hydrating) throw new Error('Save hydration must finish before another command')
    const epoch = this.epoch, version = this.version, base = this.base, child = this.child, captured = this.current, bytes = this.bytes
    const guard = () => { this.assertView(view); if (epoch !== this.epoch || base !== this.base || child !== this.child || operation !== 'savePending' && version !== this.version) throw new Error('The captured Save operation changed'); barriers() }
    guard()
    const assertInput: OwnedFileCommand['assertSaveInput'] = (id, revision, input) => {
      guard()
      if (id !== captured.documentId || revision !== captured.revision) throw new Error('Save command identity changed')
      if (operation === 'savePending' && (!input || !jsonEqual(input.pendingForm, savePendingJson(captured.input!)) || !bytes || input.bytes.length !== bytes.length || !input.bytes.every((value, index) => value === bytes[index]))) throw new Error('Pending Save command must preserve exact bytes and captured input')
    }
    const ticket = Object.freeze({ command: newOwnedFileCommand(operation, guard, undefined, assertInput), input: frozen(captured.input), documentId: captured.documentId, revision: captured.revision, version })
    this.tickets.set(ticket, { version }); return ticket
  }
  acknowledge(ticket: SaveInputTicket, revision: number): void {
    const proof = this.tickets.get(ticket)
    if (!proof) throw new Error('Unknown Save command')
    ticket.command.assertMayActivate(); this.saved = ticket.input; this.durable = proof.version
    this.current = { ...this.current, revision, dirty: this.version !== this.durable && !guestPlannerValuesEqual(comparablePending(this.current.input), comparablePending(this.saved)) }
  }
  transfer(view: SaveViewIncarnation): SaveViewIncarnation { this.assertView(view); if (!this.canTransfer()) throw new Error('Finish the active input before reopening'); this.hydrating = true; this.child = undefined; return this.view = Object.freeze({ id: Symbol('save-view') }) }
  hydrated(view: SaveViewIncarnation): void { this.assertView(view); this.hydrating = false }
  private clearOwnedContent(): void {
    // Profile cleanup cannot depend on a route view still being mounted; release deliberately retains same-profile input
    this.epoch++; this.version++; this.durable = this.version; this.current = { dirty: false }; this.saved = undefined
    // Captured commands borrow this owned buffer so cleanup also wipes their byte comparison input
    this.bytes?.fill(0); this.bytes = undefined; this.base = undefined; this.child = undefined; this.choices = undefined
    this.tickets = new WeakMap()
  }
  close(view: SaveViewIncarnation): void { this.assertView(view); this.clearOwnedContent() }
  discard(view: SaveViewIncarnation): void { this.assertView(view); this.epoch++; this.child = undefined; this.version++; this.durable = this.version; this.current = { ...this.current, input: frozen(this.saved), dirty: false } }
  release(view: SaveViewIncarnation): void { if (this.view === view) { this.view = undefined; this.child = undefined; this.epoch++; this.hydrating = false; this.composition = false; this.gesture = false; for (const resolve of this.idleWaiters) resolve(); this.idleWaiters.clear() } }
  revoke(): void { this.clearOwnedContent(); this.view = undefined; this.composition = false; this.gesture = false; this.hydrating = false; for (const resolve of this.idleWaiters) resolve(); this.idleWaiters.clear() }
}
