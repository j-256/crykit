import { resolveSaveEditorMods } from '../domain/save-editor-mods'
import { assertModSourceReceipts } from '../domain/build-reference-names'
import { jsonRecord } from '../domain/crystal-edit'
import type { JsonValue } from '../domain/types'
import { SAVE_EDITOR_CATALOG } from '../catalog/save-editor'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { inspectSave, previewVanillaConversion } from '../domain/save-editor'
import { CRYSTAL_SAVE_LIMITS, crystalSaveVersion, decodeCrystalSave, encodeCrystalSave, isSupportedCrystalSaveVersion } from '../interchange/crystal-save'
import type { WorkspaceRepository } from './repository'
import type { SaveWorkspaceDocument, WorkspaceState } from './documents'
import { SaveWorkspaceDocumentSchema } from './file-schemas'
import { blobIdentity, hashBlob, memoryBlob, readBlob } from './blobs'
import { editorBlob } from './editor-document'
import { inspectWorkspaceClosure } from './closure'
import { retainFileRevision } from './file-history'
import { commitOwnedFile, newOwnedFileCommand, type OwnedFileCommand, type OwnedFileOutcome } from './owned-file-command'

export type SaveOperation = 'saveImport' | 'savePending' | 'saveApply' | 'saveExport' | 'saveRemove'
export interface SaveRepository {
  list(): Promise<readonly SaveWorkspaceDocument[]>
  get(id: string): Promise<SaveWorkspaceDocument | undefined>
  importFile(filename: string, bytes: Uint8Array): Promise<SaveWorkspaceDocument>
  saveWorking(id: string, bytes: Uint8Array, pendingForm: JsonValue, expectedRevision: number): Promise<SaveWorkspaceDocument>
  markExported(id: string, expectedRevision: number): Promise<SaveWorkspaceDocument>
  remove(id: string, expectedRevision: number): Promise<void>
}
export interface SaveCommandHooks {
  readonly intent?: 'saveApply'
  readonly nativeIntent?: 'vanilla' | 'reset-original'
  readonly sources?: readonly import('../domain/save-editor-mods').SaveEditorModSource[]
  readonly begin?: (operation: SaveOperation) => OwnedFileCommand
  readonly onOutcome?: (outcome: OwnedFileOutcome, document?: SaveWorkspaceDocument) => void | Promise<void>
}
export function validateSaveImport(bytes: Uint8Array): void {
  if (!bytes.length) throw new Error('This save file is empty')
  if (bytes.length > CRYSTAL_SAVE_LIMITS.maxFileBytes) throw new Error('Save exceeds the 64 MiB import size limit')
}
export async function readSaveContent(state: WorkspaceState, file: SaveWorkspaceDocument) {
  SaveWorkspaceDocumentSchema.parse(file)
  const read = async (ref: SaveWorkspaceDocument['working']) => {
    const body = state.blobs.find(value => blobIdentity(value.ref) === blobIdentity(ref))
    if (!body || JSON.stringify(body.ref) !== JSON.stringify(ref) || ref.encoding !== 'bytes') throw new Error('Exact save bytes are unavailable')
    const bytes = await readBlob(body.content, CRYSTAL_SAVE_LIMITS.maxFileBytes)
    if (await hashBlob(memoryBlob(bytes)) !== ref.sha256) { bytes.fill(0); throw new Error('Exact save bytes are unavailable') }
    return bytes
  }
  const originalBytes = await read(file.original)
  const workingBytes = JSON.stringify(file.original) === JSON.stringify(file.working) ? originalBytes.slice() : await read(file.working)
  return { originalBytes, workingBytes }
}
export async function saveExportStatus(state: WorkspaceState, file: SaveWorkspaceDocument): Promise<'never' | 'requested' | 'changed' | 'unknown'> {
  if (file.exportedRevision === null) return 'never'
  const candidates: SaveWorkspaceDocument[] = []
  for (const entry of state.retainedContent) {
    if (entry.kind !== 'file-history' || entry.fileKind !== 'save' || entry.documentId !== file.id) continue
    const parsed = SaveWorkspaceDocumentSchema.parse((await inspectWorkspaceClosure(state, entry.content)).value)
    if (parsed.id === file.id && parsed.revision === file.exportedRevision) candidates.push(parsed as unknown as SaveWorkspaceDocument)
  }
  // A revision number cannot disambiguate independent branches, even when one happens to share today's bytes
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : value
  const identities = new Set(candidates.map(value => JSON.stringify(canonical(value))))
  if (identities.size !== 1) return 'unknown'
  return JSON.stringify(canonical(candidates[0].working)) === JSON.stringify(canonical(file.working)) ? 'requested' : 'changed'
}
export function createSaveRepository(repository: WorkspaceRepository, hooks: SaveCommandHooks = {}): SaveRepository {
  const command = (operation: SaveOperation) => hooks.begin?.(operation) ?? newOwnedFileCommand(operation)
  const selected = (state: WorkspaceState, id: string, revision: number) => {
    const file = state.saveDocuments.find(value => value.id === id)
    if (!file || file.revision !== revision) throw new Error('The saved revision changed. Keep pending input and reopen it.')
    SaveWorkspaceDocumentSchema.parse(file)
    return file
  }
  async function finish(before: WorkspaceState, next: WorkspaceState, ticket: OwnedFileCommand, file?: SaveWorkspaceDocument) {
    const outcome = await commitOwnedFile(repository, before, next, ticket)
    await hooks.onOutcome?.(outcome, file)
    if (outcome.status !== 'saved') throw outcome.error ?? new Error('Save outcome needs reconciliation')
  }
  return {
    list: async () => (await repository.readWorkspace()).saveDocuments,
    get: async id => (await repository.readWorkspace()).saveDocuments.find(value => value.id === id),
    importFile: async (filename, input) => {
      validateSaveImport(input)
      const bytes = input.slice(), ticket = command('saveImport'), before = await repository.readWorkspace()
      const version = crystalSaveVersion(bytes[0]), diagnostics: string[] = []
      let supported = false
      try {
        if (!isSupportedCrystalSaveVersion(version)) throw new Error(`Save format ${version} is unsupported`)
        const save = decodeCrystalSave(bytes), summary = inspectSave(save, SAVE_EDITOR_CATALOG)
        supported = true
        if (!summary.editable) diagnostics.push('Exact editing context is unavailable. Working bytes remain read-only until native coverage is verified.')
      } catch (error) { diagnostics.push(error instanceof Error ? error.message : String(error)) }
      const original = await editorBlob(bytes, 'bytes'), timestamp = new Date().toISOString()
      const file: SaveWorkspaceDocument = { version: 1, id: crypto.randomUUID(), revision: 1, filename, original: original.ref, working: original.ref, pendingForm: null, requirements: [], coverage: { status: supported ? 'supported' : 'unsupported', codecVersion: String(version), diagnostics }, createdAt: timestamp, updatedAt: timestamp, exportedRevision: null }
      SaveWorkspaceDocumentSchema.parse(file)
      await finish(before, { ...before, saveDocuments: [...before.saveDocuments, file], blobs: [...before.blobs, original] }, ticket, file)
      return file
    },
    saveWorking: async (id, input, pendingForm, revision) => {
      validateSaveImport(input)
      const bytes = input.slice(), pending = structuredClone(pendingForm), before = await repository.readWorkspace(), previous = selected(before, id, revision)
      const current = await readSaveContent(before, previous)
      const unchanged = bytes.length === current.workingBytes.length && bytes.every((value, index) => value === current.workingBytes[index])
      const operation = hooks.intent ?? (unchanged ? 'savePending' : 'saveApply'), ticket = command(operation)
      ticket.assertSaveInput?.(id, revision, { bytes, pendingForm: pending })
      if (!unchanged) {
        if (previous.coverage.status !== 'supported') throw new Error('Unsupported saves are read-only')
        const identical = (candidate: Uint8Array) => bytes.length === candidate.length && bytes.every((value, index) => value === candidate[index])
        if (hooks.nativeIntent === 'reset-original') {
          if (!identical(current.originalBytes)) throw new Error('Reset must preserve the exact original bytes')
        } else if (hooks.nativeIntent === 'vanilla') {
          const preview = previewVanillaConversion(decodeCrystalSave(current.workingBytes), SAVE_EDITOR_CATALOG)
          if (!preview.convertible || !preview.draft || !identical(encodeCrystalSave(preview.draft))) throw new Error('Vanilla conversion must match the complete native preview')
        } else {
          // Codec support alone is not edit coverage, including mod/randomizer identity and native value validation
          if (!inspectSave(decodeCrystalSave(current.workingBytes), SAVE_EDITOR_CATALOG, hooks.sources).editable || !inspectSave(decodeCrystalSave(bytes), SAVE_EDITOR_CATALOG, hooks.sources).editable) throw new Error('Exact native editing context is unavailable')
        }
      }
      let requirements = previous.requirements
      // An explicit pending-input reset may target unsupported bytes; it cannot infer new source requirements
      if (operation === 'saveApply' && !unchanged) {
        const resolution = resolveSaveEditorMods(decodeCrystalSave(bytes), SAVE_EDITOR_CATALOG, hooks.sources ?? [])
        const matched = new Set(resolution.activeMods.flatMap(mod => mod.matched && mod.sourceChecksum ? [mod.sourceChecksum] : []))
        const receipts = (hooks.sources ?? []).flatMap(source => {
          const catalog = source.catalog
          if (!catalog || !matched.has(source.checksum)) return []
          const legacy = jsonRecord(catalog.legacy) ? catalog.legacy : {}
          return [{ catalogId: catalog.id, catalogRevisionId: catalog.revisionId, checksum: catalog.checksum, title: source.title, ...(typeof legacy.contentFingerprint === 'string' ? { contentFingerprint: legacy.contentFingerprint } : {}) }]
        })
        const entries = new Map(previous.requirements.map(value => [JSON.stringify([value.catalogId, value.catalogRevisionId]), value]))
        for (const receipt of receipts) {
          const key = JSON.stringify([receipt.catalogId, receipt.catalogRevisionId]), old = entries.get(key)
          if (old && old.checksum !== receipt.checksum) throw new Error('Exact Save source receipt changed')
          entries.set(key, receipt)
        }
        requirements = [...entries.values()]
        // Temporary full sources establish exact receipts, without publishing filtered scopes or an account library
        assertModSourceReceipts({ modSourceReceipts: requirements, modComposition: { version: 2, baseline: { catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId }, layers: requirements.map(value => ({ catalogId: value.catalogId, catalogRevisionId: value.catalogRevisionId, enabled: true })), links: [] } })
      }
      const body = unchanged ? undefined : await editorBlob(bytes, 'bytes')
      const file: SaveWorkspaceDocument = { ...previous, requirements, working: body?.ref ?? previous.working, pendingForm: pending, revision: revision + 1, updatedAt: new Date().toISOString() }
      SaveWorkspaceDocumentSchema.parse(file)
      const retained = await retainFileRevision(before, previous, operation === 'savePending' ? 'autosave-recovery' : 'protected')
      await finish(before, { ...retained, saveDocuments: retained.saveDocuments.map(value => value.id === id ? file : value), blobs: [...retained.blobs, ...(body ? [body] : [])] }, ticket, file)
      return file
    },
    markExported: async (id, revision) => {
      const ticket = command('saveExport')
      ticket.assertSaveInput?.(id, revision)
      const before = await repository.readWorkspace(), previous = selected(before, id, revision)
      const file = { ...previous, revision: revision + 1, exportedRevision: revision, updatedAt: new Date().toISOString() }
      // Protect the entire exact pre-marker container; byte equality alone cannot prove which request occurred
      const retained = await retainFileRevision(before, previous, 'protected')
      await finish(before, { ...retained, saveDocuments: retained.saveDocuments.map(value => value.id === id ? file : value) }, ticket, file)
      return file
    },
    remove: async (id, revision) => {
      const ticket = command('saveRemove')
      ticket.assertSaveInput?.(id, revision)
      const before = await repository.readWorkspace(), previous = selected(before, id, revision), retained = await retainFileRevision(before, previous, 'protected')
      await finish(before, { ...retained, saveDocuments: retained.saveDocuments.filter(value => value.id !== id) }, ticket)
    },
  }
}
