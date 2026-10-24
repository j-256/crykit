import { newOwnedFileCommand, type OwnedFileCommand } from './owned-file-command'

export type BuildInputField = 'id' | 'revisionId' | 'title' | 'tags' | 'behavior' | 'draftIdentity' | 'draft' | 'assumptions' | 'newTeamMember' | 'teamMemberName' | 'teamId' | 'teamTitle' | 'teamSlots' | 'teamSetup' | 'teamBehavior' | 'teamMember' | 'teamMemberDirty' | 'teamPreviewSetupId' | 'sourcesOpen' | 'sourceRecovery' | 'copiedNotes' | 'copiedSetup'
export interface BuildInputView { readonly id: symbol }
// This volatile capsule contains form values only, never callbacks or portable repository authority
export class BuildInputController {
  readonly owner = Symbol('build-import-owner')
  private view?: BuildInputView
  private version = 0
  private fields = new Map<BuildInputField, unknown>()
  private changed = false
  private transferring = false
  snapshot(): { readonly dirty: boolean } { return { dirty: this.changed } }
  attach(): BuildInputView {
    if (this.view) throw new Error('The Build already has an input owner')
    this.view = Object.freeze({ id: Symbol('build-view') })
    return this.view
  }
  assertView(view: BuildInputView): void { if (view !== this.view) throw new Error('This Build form was retired') }
  read<T>(view: BuildInputView, key: BuildInputField, initial: () => T): T {
    this.assertView(view)
    if (!this.fields.has(key)) this.fields.set(key, structuredClone(initial()))
    return structuredClone(this.fields.get(key)) as T
  }
  edit<T>(view: BuildInputView, key: BuildInputField, value: T): void {
    this.assertView(view)
    if (this.transferring) throw new Error('Wait for the imported source to reopen this Build')
    this.version++; this.fields.set(key, structuredClone(value))
  }
  clearFields(view: BuildInputView, fields: readonly BuildInputField[]): void {
    this.assertView(view)
    if (this.transferring) throw new Error('Wait for the imported source to reopen this form')
    this.version++
    for (const field of fields) this.fields.delete(field)
  }
  dirty(view: BuildInputView, value: boolean): void { this.assertView(view); if (this.changed !== value) this.version++; this.changed = value }
  capture(view: BuildInputView, barriers: () => void): OwnedFileCommand {
    this.assertView(view)
    if (this.transferring) throw new Error('The Build import is still reopening')
    const version = this.version
    const assertMayActivate = () => {
      this.assertView(view)
      if (version !== this.version) throw new Error('The Build changed during import. Its input is kept for recovery.')
      barriers()
    }
    assertMayActivate()
    return newOwnedFileCommand('libraryImport', assertMayActivate)
  }
  transfer(view: BuildInputView): BuildInputView {
    this.assertView(view); this.transferring = true
    this.view = Object.freeze({ id: Symbol('build-view') })
    return this.view
  }
  hydrated(view: BuildInputView): void { this.assertView(view); this.transferring = false }
  recoveryInput(view: BuildInputView): Readonly<Record<string, unknown>> {
    this.assertView(view)
    return structuredClone(Object.fromEntries(this.fields))
  }
  release(view: BuildInputView): void { if (this.view === view) this.revoke() }
  revoke(): void { this.view = undefined; this.version++; this.fields.clear(); this.changed = false; this.transferring = false }
}
