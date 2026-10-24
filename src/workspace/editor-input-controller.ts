import { z } from 'zod'
import type { JsonValue } from '../domain/types'
import type { JsonPath } from '../mod-inspector/types'
import type { UnfinishedEditorInput } from './editor-repository'
import { newOwnedFileCommand, type OwnedFileCommand, type OwnedFileOperation } from './owned-file-command'
import { guestPlannerValuesEqual } from '../persistence/guest-planner-equality'

const patchSchema = z.object({ start: z.number().int().nonnegative(), before: z.string(), after: z.string() }).strict()
export const EditorMapCameraSchema = z.object({ rotation: z.number().int().min(0).max(7), elevation: z.number().min(0).max(90), zoom: z.number().min(.5).max(2), center: z.object({ X: z.number(), Y: z.number(), Z: z.number() }).strict(), planeHeight: z.string().nullable(), mode: z.enum(['ground', 'height']) }).strict()
export type EditorMapCameraInput = z.infer<typeof EditorMapCameraSchema>
// Optional attempt intent keeps older drafts readable and never authorizes a map mutation
export const EditorMapInputSchema = z.object({ camera: EditorMapCameraSchema, layerId: z.number().int(), selectedId: z.number().int().nullable(), tool: z.enum(['paint', 'erase', 'move', 'platform']), constructionPlane: z.boolean(), view: z.enum(['isometric', 'overview']), picking: z.boolean(), showNative: z.boolean(), query: z.string(), voxelQuery: z.string(), resultLimit: z.number().int().positive(), values: z.object({ X: z.string(), Y: z.string(), Z: z.string() }).strict(), biomeId: z.string(), voxelId: z.string(), width: z.string(), depth: z.string(), dirty: z.boolean(), brushSize: z.number().int().positive(), validationAttempted: z.boolean(), validationAction: z.enum(['move', 'platform']).nullable(), history: z.object({ past: z.array(patchSchema), future: z.array(patchSchema) }).strict() }).partial().strict()
export type EditorMapInputKey = keyof z.infer<typeof EditorMapInputSchema>
function frozen<T>(input: T): T {
  const copy = structuredClone(input), pending: unknown[] = [copy]
  while (pending.length) { const value = pending.pop(); if (value && typeof value === 'object') { pending.push(...Object.values(value)); Object.freeze(value) } }
  return copy
}

export interface EditorViewIncarnation { readonly id: symbol }
interface ContentBase { readonly original: string; readonly applied: string; readonly reference: string }
export interface EditorFocus { readonly key: string; readonly start: number | null; readonly end: number | null; readonly direction: 'forward' | 'backward' | 'none' | null }
export interface EditorInputSnapshot {
  readonly documentId?: string
  readonly revision?: number
  readonly input?: UnfinishedEditorInput
  readonly dirty: boolean
  readonly focus?: EditorFocus
}
export interface EditorInputTicket {
  readonly command: OwnedFileCommand
  readonly input?: UnfinishedEditorInput
  readonly documentId?: string
  readonly revision?: number
  readonly version: number
}
interface TicketProof { readonly epoch: number; readonly version: number; readonly view: EditorViewIncarnation; readonly base?: ContentBase }
export class EditorInputController {
  readonly owner = Symbol('editor-input-owner')
  private view?: EditorViewIncarnation
  private epoch = 0
  private version = 0
  private durable = 0
  private base?: ContentBase
  private current: EditorInputSnapshot = { dirty: false }
  private saved?: UnfinishedEditorInput
  private composition = false
  private gesture = false
  private hydrating = false
  private readonly idleWaiters = new Set<() => void>()
  private readonly tickets = new WeakMap<EditorInputTicket, TicketProof>()
  snapshot(): EditorInputSnapshot { return Object.freeze(this.current) }
  attach(): EditorViewIncarnation {
    if (this.view) throw new Error('The editor input already has a live owner')
    this.view = Object.freeze({ id: Symbol('editor-view') })
    return this.view
  }
  assertView(view: EditorViewIncarnation): void { if (this.view !== view) throw new Error('This editor view was retired') }
  open(view: EditorViewIncarnation, documentId: string, revision: number, base: ContentBase, input: UnfinishedEditorInput): void {
    this.assertView(view); this.epoch++; this.version++; this.durable = this.version
    this.base = Object.freeze({ ...base }); this.saved = frozen(input)
    this.current = { documentId, revision, input: frozen(input), dirty: false }
  }
  private edit(view: EditorViewIncarnation, input: UnfinishedEditorInput): void {
    this.assertView(view)
    if (!this.current.input) throw new Error('Open an editor document before editing')
    this.version++
    // Returning to the exact durable input cancels redundant quiet saves without revalidating old command tickets
    // Version ancestry still advances, so Apply cannot reuse authority captured before later typing
    this.current = { ...this.current, input: frozen(input), dirty: this.version !== this.durable && !guestPlannerValuesEqual(input, this.saved) }
  }
  editText(view: EditorViewIncarnation, text: string): void { this.edit(view, { ...this.current.input!, text, validation: 'unchecked' }) }
  editPath(view: EditorViewIncarnation, editedPath: JsonPath): void { this.edit(view, { ...this.current.input!, editedPath }) }
  editField(view: EditorViewIncarnation, key: string, value: JsonValue): void {
    // Only the declared inert form namespace can advance ancestry; identities and applied bases cannot
    if (!['editor', 'editorLoaded', 'editorDirty', 'workingText', 'tab'].includes(key)) throw new Error('Unsupported inert editor field')
    const previous = this.current.input?.fieldState
    const fields = previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {}
    this.edit(view, { ...this.current.input!, fieldState: { ...fields, [key]: structuredClone(value) } })
  }
  editMapField(view: EditorViewIncarnation, key: EditorMapInputKey, value: JsonValue): void {
    const shape = EditorMapInputSchema.shape[key]
    if (!shape) throw new Error('Unsupported map input transition')
    shape.parse(value)
    const fields = this.current.input?.fieldState as Record<string, JsonValue> | null
    const oldMap = EditorMapInputSchema.parse(fields?.map ?? {})
    this.edit(view, { ...this.current.input!, fieldState: { ...fields, map: { ...oldMap, [key]: value } as JsonValue } })
  }
  rememberFocus(view: EditorViewIncarnation, focus: EditorFocus | undefined): void { this.assertView(view); this.current = { ...this.current, focus: frozen(focus) } }
  setInteraction(view: EditorViewIncarnation, kind: 'composition' | 'gesture', value: boolean): void { this.assertView(view); if (kind === 'composition') this.composition = value; else this.gesture = value; if (this.canTransfer()) { for (const resolve of this.idleWaiters) resolve(); this.idleWaiters.clear() } }
  canTransfer(): boolean { return !this.composition && !this.gesture }
  async waitForTransfer(): Promise<void> { if (!this.canTransfer()) await new Promise<void>(resolve => this.idleWaiters.add(resolve)) }
  capture(view: EditorViewIncarnation, operation: OwnedFileOperation, assertOtherBarriers: () => void): EditorInputTicket {
    this.assertView(view)
    if (this.hydrating) throw new Error('Editor hydration must finish before another command')
    const proof: TicketProof = { epoch: this.epoch, version: this.version, view, base: this.base }
    const guard = () => {
      this.assertView(view)
      if (this.epoch !== proof.epoch || this.base !== proof.base || (operation !== 'saveUnfinished' && this.version !== proof.version)) throw new Error('The captured editor operation changed')
      assertOtherBarriers()
    }
    guard()
    const captured = this.current
    const assertInput = (id: string, revision: number, input?: UnfinishedEditorInput) => {
      // Descendant permission applies only to this immutable payload, never to caller-supplied replacement state
      if (id !== captured.documentId || revision !== captured.revision || operation === 'saveUnfinished' && JSON.stringify(input) !== JSON.stringify(captured.input)) throw new Error('The file command does not match its captured editor input')
    }
    const ticket = Object.freeze({ command: newOwnedFileCommand(operation, guard, assertInput), input: frozen(captured.input), documentId: captured.documentId, revision: captured.revision, version: this.version })
    this.tickets.set(ticket, proof)
    return ticket
  }
  acknowledge(ticket: EditorInputTicket, revision: number): void {
    const proof = this.tickets.get(ticket)
    if (!proof) throw new Error('Unknown editor command')
    ticket.command.assertMayActivate()
    this.saved = ticket.input
    this.durable = proof.version
    this.current = { ...this.current, revision, dirty: this.version !== this.durable && !guestPlannerValuesEqual(this.current.input, this.saved) }
  }
  transfer(view: EditorViewIncarnation): EditorViewIncarnation {
    this.assertView(view)
    if (!this.canTransfer()) throw new Error('Finish composing text or the map gesture before reopening')
    this.hydrating = true
    this.view = Object.freeze({ id: Symbol('editor-view') })
    return this.view
  }
  hydrated(view: EditorViewIncarnation): void { this.assertView(view); this.hydrating = false }
  close(view: EditorViewIncarnation): void { this.assertView(view); this.epoch++; this.version++; this.durable = this.version; this.current = { dirty: false }; this.saved = undefined; this.base = undefined }
  discard(view: EditorViewIncarnation): void {
    this.assertView(view); this.epoch++; this.version++; this.durable = this.version
    this.current = { ...this.current, input: frozen(this.saved), dirty: false }
  }
  release(view: EditorViewIncarnation): void { if (this.view === view) { this.view = undefined; this.epoch++; this.hydrating = false; this.composition = false; this.gesture = false; for (const resolve of this.idleWaiters) resolve(); this.idleWaiters.clear() } }
  revoke(): void { for (const resolve of this.idleWaiters) resolve(); this.idleWaiters.clear(); this.view = undefined; this.epoch++; this.current = { dirty: false }; this.saved = undefined; this.base = undefined; this.composition = false; this.gesture = false; this.hydrating = false }
}
