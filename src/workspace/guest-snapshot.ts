import Dexie from 'dexie'
import { BUNDLED_CATALOGS } from '../catalog/bundled'
import { catalogSnapshotKey } from '../interchange/identity'
import { validateNativeLocalDataGraph } from '../interchange/native'
import { captureProfileEpoch } from '../account/profile'
import { DOCUMENT_LIMITS } from '../mod-inspector/document'
import { INSPECTOR_TEXT_CHUNK_CODE_UNITS, InspectorStorage } from '../mod-inspector/storage'
import { readInspectorFileInfo } from '../mod-inspector/file-info'
import type { LocalDataRecord, CatalogRecord, MetaRecord } from '../persistence/database'
import { GUEST_PLANNER_LAYOUT_KEY, guestPlannerValuesEqual, mergeGuestPlannerEvidence, validateGuestPlannerRecord, type ValidatedGuestPlanner } from '../persistence/guest-planner-record'
import type { SourceArchiveRecord } from '../interchange/types'
import { encodeEditorText } from './editor-document'
import { captureLegacyBranch, compareLegacyBranch, readLegacyCapture, LegacyCaptureDatabase, type LegacyCapture, type LegacyParticipant } from './legacy-capture'
import { GuestManifestV2Schema } from './guest-coordinator'
import { assertGuestCurrent, type GuestBindings } from './guest-workspace'
import { blobIdentity, BLOB_CHUNK_BYTES, hashBlob } from './blobs'
import type { WorkspaceState, WorkspaceBlobRef, BlobSource } from './documents'
import { ownWorkspaceSnapshot, backupMetadataDigest, validateWorkspaceSnapshot, type WorkspaceSnapshot } from './snapshot'
import { WorkspaceBackupError } from '../interchange/workspace-backup-schema'

import { readCapturedGuestEvidence } from './guest-evidence-capture'
import { GUEST_EVIDENCE_STORES, GUEST_FILES_V1_STORES, GuestExtensionsSchema, guestEvidenceSources, mergeGuestSavedChanges, type CapturedGuestEvidence } from './guest-evidence'
import { joinWorkspaceSnapshotEvidence, type InheritedSnapshotSources } from '../interchange/workspace-backup-evidence'

const allowed = (value: object, fields: readonly string[]) => { if (Object.keys(value).some(key => !fields.includes(key))) throw new Error('Unsupported legacy backup metadata. Original data was retained.') }
const PLANNER_TABLES = ['catalogs', 'evidence', 'history', 'imports', 'localDatas', 'meta', 'sources'] as const
const INSPECTOR_TABLES = ['chunks', 'drafts', 'meta'] as const
const FILE_TABLES = [...Object.keys(GUEST_FILES_V1_STORES), ...Object.keys(GUEST_EVIDENCE_STORES)].sort()
type LegacyRow = { schemaVersion: number; layoutVersion?: number; id: string; filename: string; referenceId: string; createdAt: string; updatedAt: string; revision: number; fileInfo?: unknown; originalText?: string; draftText?: string; originalPayload?: Manifest; draftPayload?: Manifest }
type Manifest = { codeUnits: number; chunkCount: number; checksums: number[] }
async function projectCapturedGuestState(
  frozen: LegacyCaptureDatabase,
  capture: LegacyCapture,
  guard: () => void,
  check: () => Promise<void>,
  mode: 'legacy' | 'journaled',
  allowLegacyEmpty = false,
): Promise<{ state: WorkspaceState; sidecar: CapturedGuestEvidence; destinationChanges: WorkspaceState['planner']['localData']['changes'] }> {
  let local: LocalDataRecord | undefined
  const catalogs: WorkspaceState['planner']['catalogs'][number][] = [...BUNDLED_CATALOGS], catalogRows: CatalogRecord[] = [], metaRows: MetaRecord[] = [], sources: WorkspaceState['planner']['sources'][number][] = [], evidence: WorkspaceState['planner']['evidence'][number][] = [], history: WorkspaceState['planner']['history'][number][] = []
  const files = { editorDocuments: [], saveDocuments: [], assets: [], libraryDefaults: { version: 1, layers: [] }, conflicts: [], retainedContent: [] } as unknown as Omit<WorkspaceState, 'planner' | 'blobs'>
  const blobs: WorkspaceState['blobs'][number][] = [], drafts: { row: LegacyRow; ordinal: number }[] = []
  const chunks = new Map<string, number>(), inspectorChunks = new Map<string, number>()
  const read = async (ordinal: number) => { guard(); const value = await frozen.records.get([capture.id, ordinal]); guard(); if (!value) throw new Error('Frozen backup record disappeared'); return value.value }
  const iterator = readLegacyCapture(frozen, capture)[Symbol.asyncIterator]()
  try { for (;;) {
    guard()
    const next = await iterator.next()
    guard()
    if (next.done) break
    const record = next.value
    if (record.kind === 'table-end') continue
    if (record.participant === 'planner') {
      if (record.table === 'localDatas') { if (local || record.key !== 'local-data-record') throw new Error('Unsupported saved planner roots'); local = record.value as LocalDataRecord }
      else if (record.table === 'catalogs') { catalogRows.push(record.value as CatalogRecord); catalogs.push((record.value as CatalogRecord).snapshot) }
      else if (record.table === 'evidence') evidence.push(record.value as typeof evidence[number])
      else if (record.table === 'history') history.push(record.value as typeof history[number])
      else if (record.table === 'sources') {
        const { bytes, ...metadata } = record.value as SourceArchiveRecord
        const ref: WorkspaceBlobRef = { documentId: `source:${metadata.id}`, revisionId: metadata.digest, byteLength: bytes.length, sha256: metadata.digest, encoding: 'bytes' }
        const ordinal = record.ordinal
        sources.push({ ...metadata, original: ref })
        blobs.push({ ref, content: { byteLength: ref.byteLength, async *open() { const saved = await read(ordinal) as SourceArchiveRecord; for (let at = 0; at < saved.bytes.length; at += BLOB_CHUNK_BYTES) { guard(); yield saved.bytes.subarray(at, at + BLOB_CHUNK_BYTES) } } } })
      } else if (record.table === 'meta') metaRows.push(record.value as MetaRecord)
      else if (record.table !== 'imports') throw new Error('Unsupported planner table')
    } else if (record.participant === 'files') {
      if (record.table === 'documents') {
        const { key, value } = record.value as { key: string; value: unknown }
        if (key === 'workspaceExtensions') { GuestExtensionsSchema.parse(value); continue }
        if (key === 'libraryDefaults') (files as { libraryDefaults: WorkspaceState['libraryDefaults'] }).libraryDefaults = value as WorkspaceState['libraryDefaults']
        else { const [field, id] = JSON.parse(key); if (!['editorDocuments', 'saveDocuments', 'assets', 'conflicts', 'retainedContent'].includes(field) || (value as { id: string }).id !== id) throw new Error('Unsupported file document'); (files[field as keyof typeof files] as unknown[]).push(value) }
      } else if (record.table === 'blobs') {
        const { key, ref } = record.value as { key: string; ref: WorkspaceBlobRef }
        if (key !== blobIdentity(ref)) throw new Error('Invalid frozen blob identity')
        blobs.push({ ref, content: { byteLength: ref.byteLength, async *open() {
          let index = 0, bytes = 0
          while (bytes < ref.byteLength) {
            const ordinal = chunks.get(JSON.stringify([key, index++])); if (ordinal === undefined) throw new Error('Missing frozen blob chunk')
            const row = await read(ordinal) as { key: string; index: number; bytes: Uint8Array }
            if (row.key !== key || row.index !== index - 1 || !row.bytes.length) throw new Error('Invalid frozen blob chunk')
            bytes += row.bytes.length; if (bytes > ref.byteLength) throw new Error('Trailing frozen blob bytes')
            yield row.bytes
          }
          if (chunks.has(JSON.stringify([key, index]))) throw new Error('Trailing frozen blob chunks')
        } } })
      } else if (record.table === 'chunks') chunks.set(JSON.stringify(record.key), record.ordinal)
      else if (record.table !== 'meta' && !(record.table in GUEST_EVIDENCE_STORES)) throw new Error('Unsupported file table')
    } else {
      if (record.table === 'drafts') drafts.push({ row: record.value as LegacyRow, ordinal: record.ordinal })
      else if (record.table === 'chunks') inspectorChunks.set(JSON.stringify(record.key), record.ordinal)
      else if (record.table !== 'meta' || record.value !== undefined) throw new Error('Unsupported Inspector metadata. Original data was retained.')
    }
  } } finally { await iterator.return?.() }
  if (!local) throw new Error('Save the planner before creating a complete backup')
  let admitted: Extract<ValidatedGuestPlanner, { format: 'journaled' }> | undefined
  if (mode === 'journaled') {
    const declarations = metaRows.filter(row => row.key === GUEST_PLANNER_LAYOUT_KEY)
    if (declarations.length !== 1) throw new Error('Missing guest planner format declaration')
    const parsed = validateGuestPlannerRecord(local, declarations[0], history, 'journaled', String(local.localData.schemaVersion) === '2.4.0')
    if (parsed.format !== 'journaled') throw new Error('Guest planner must be journaled')
    admitted = parsed
    const bundledKeys = new Set(BUNDLED_CATALOGS.map(row => catalogSnapshotKey(row.id, row.revisionId)))
    for (const row of catalogRows) {
      const key = catalogSnapshotKey(row.snapshot.id, row.snapshot.revisionId)
      if (row.key !== key || row.id !== row.snapshot.id || row.revisionId !== row.snapshot.revisionId || row.checksum !== row.snapshot.checksum) throw new Error('Catalog wrapper differs from its snapshot')
      const bundled = BUNDLED_CATALOGS.find(value => catalogSnapshotKey(value.id, value.revisionId) === row.key)
      if (bundled && !guestPlannerValuesEqual(bundled, row.snapshot)) throw new Error('Stored packaged catalog differs from its exact pin')
    }
    // Collection reuse never admits mutable stored catalog contents by identity
    const additionalCatalogs = catalogRows.filter(row => !bundledKeys.has(row.key)).map(row => row.snapshot)
    const operativeCatalogs = additionalCatalogs.length ? Object.freeze([...BUNDLED_CATALOGS, ...additionalCatalogs]) : BUNDLED_CATALOGS
    for (const endpoint of [local.localData, ...admitted.journal.checkpoints.flatMap(entry => [entry.before, entry.after])]) validateNativeLocalDataGraph(endpoint, operativeCatalogs)
  }
  for (const { row, ordinal } of drafts) {
    if (files.editorDocuments.some(file => file.id === row.id) || files.retainedContent.some(file => file.kind === 'file-history' && file.fileKind === 'editor' && file.documentId === row.id)) continue
    allowed(row, ['schemaVersion', 'layoutVersion', 'id', 'filename', 'referenceId', 'createdAt', 'updatedAt', 'revision', 'fileInfo', 'originalText', 'draftText', 'originalPayload', 'draftPayload'])
    if (row.schemaVersion !== 1 || !Number.isSafeInteger(row.revision) || row.revision < 1) throw new Error('Unsupported Inspector draft metadata')
    if (row.fileInfo !== undefined) {
      const info = readInspectorFileInfo(row.fileInfo)
      if (!info || Object.keys(row.fileInfo as object).some(key => !Object.keys(info).includes(key))) throw new Error('Unsupported Inspector file metadata')
    }
    const payload = async (kind: 'original' | 'draft') => {
      const inline = kind === 'original' ? row.originalText : row.draftText
      const manifest = kind === 'original' ? row.originalPayload : row.draftPayload
      const units = manifest?.codeUnits ?? inline?.length
      if (!Number.isSafeInteger(units) || !units || units > DOCUMENT_LIMITS.textLength) throw new Error('Inspector backup text exceeds its supported bound')
      if (row.layoutVersion !== undefined && row.layoutVersion !== 2 || row.layoutVersion === 2 && (!manifest || inline !== undefined) || row.layoutVersion === undefined && (manifest !== undefined || typeof inline !== 'string')) throw new Error('Unsupported Inspector text layout')
      if (manifest) {
        allowed(manifest, ['codeUnits', 'chunkCount', 'checksums'])
        if (manifest.chunkCount !== Math.ceil(units / INSPECTOR_TEXT_CHUNK_CODE_UNITS) || !Array.isArray(manifest.checksums) || manifest.checksums.length !== manifest.chunkCount) throw new Error('Invalid Inspector manifest')
      }
      const content: BlobSource = { byteLength: units * 2, async *open() {
        if (!manifest) {
          const saved = await read(ordinal) as LegacyRow
          const text = kind === 'original' ? saved.originalText : saved.draftText
          if (typeof text !== 'string' || text.length !== units) throw new Error('Invalid inline Inspector text')
          for (let at = 0; at < text.length; at += BLOB_CHUNK_BYTES / 2) yield encodeEditorText(text.slice(at, at + BLOB_CHUNK_BYTES / 2))
        } else for (let index = 0; index < manifest.chunkCount; index++) {
          const position = inspectorChunks.get(JSON.stringify([row.id, kind, index])); if (position === undefined) throw new Error('Missing Inspector text chunk')
          const value = await read(position) as { layoutVersion: number; draftId: string; kind: string; revision: number; index: number; text: string }
          allowed(value, ['layoutVersion', 'draftId', 'kind', 'revision', 'index', 'text'])
          if (value.layoutVersion !== 2 || value.draftId !== row.id || value.kind !== kind || value.revision !== (kind === 'original' ? 1 : row.revision) || value.index !== index || typeof value.text !== 'string' || value.text.length !== Math.min(INSPECTOR_TEXT_CHUNK_CODE_UNITS, units - index * INSPECTOR_TEXT_CHUNK_CODE_UNITS)) throw new Error('Invalid Inspector text chunk')
          let checksum = 2_166_136_261
          for (let at = 0; at < value.text.length; at++) checksum = Math.imul(checksum ^ value.text.charCodeAt(at), 16_777_619)
          if ((checksum >>> 0) !== manifest.checksums[index]) throw new Error('Inspector text checksum mismatch')
          for (let at = 0; at < value.text.length; at += BLOB_CHUNK_BYTES / 2) yield encodeEditorText(value.text.slice(at, at + BLOB_CHUNK_BYTES / 2))
        }
      } }
      const ref: WorkspaceBlobRef = { documentId: `legacy-editor:${row.id}:${kind}`, revisionId: String(row.revision), byteLength: content.byteLength, sha256: await hashBlob(content), encoding: 'utf16le' }
      blobs.push({ ref, content }); return ref
    }
    const original = await payload('original'), draft = await payload('draft')
    const expectedChunks = (row.originalPayload?.chunkCount ?? 0) + (row.draftPayload?.chunkCount ?? 0)
    if ([...inspectorChunks.keys()].filter(key => JSON.parse(key)[0] === row.id).length !== expectedChunks) throw new Error('Unexpected Inspector text chunks')
    ;(files.editorDocuments as WorkspaceState['editorDocuments'][number][]).push({ version: 1, id: row.id, revision: row.revision, filename: row.filename, referenceId: row.referenceId, original, originalByteIdentity: 'text-only', lastApplied: draft, unfinished: { text: draft, editedPath: [], fieldState: null, baseRevision: row.revision, validation: 'unchecked' }, createdAt: row.createdAt, updatedAt: row.updatedAt })
  }
  const knownDrafts = new Set(drafts.map(({ row }) => row.id))
  for (const key of inspectorChunks.keys()) if (!knownDrafts.has(JSON.parse(key)[0])) throw new Error('Orphaned Inspector text chunks. Original data was retained.')
  const sidecar = await readCapturedGuestEvidence(frozen, capture, check, allowLegacyEmpty, mode === 'journaled' ? guard : undefined)
  const savedChanges = admitted
    ? mergeGuestPlannerEvidence([sidecar.planner.savedChanges, admitted.descriptor.savedDestinationChanges], value => value.id)
    : sidecar.planner.savedChanges.length ? mergeGuestSavedChanges(sidecar.planner.savedChanges, local.localData.changes) : undefined
  const state: WorkspaceState = { ...files, planner: { localData: local.localData, lineage: local.lineage, catalogs: [...new Map(catalogs.map(value => [JSON.stringify([value.id, value.revisionId]), value])).values()], sources, evidence, history, ...(savedChanges ? { savedChanges } : {}), ...(admitted ? { journal: admitted.journal } : {}) }, blobs }
  await check()
  return { state, sidecar, destinationChanges: admitted?.descriptor.savedDestinationChanges ?? local.localData.changes }
}

export async function captureGuestSnapshot(binding: GuestBindings): Promise<WorkspaceSnapshot> {
  const epoch = captureProfileEpoch()
  const frozen = new LegacyCaptureDatabase(`crykit-backup-guest-capture-${crypto.randomUUID()}`)
  const requiredInspector = binding.manifest.version === 2 ? new InspectorStorage(binding.manifest.inspector, { requiredGuestTarget: true }) : undefined
  const inspector = new Dexie(binding.manifest.inspector)
  let disposed = false
  let disposal: Promise<void> | undefined
  const dispose = (): Promise<void> => { if (disposal) return disposal; disposed = true; requiredInspector?.close(); inspector.close(); disposal = Promise.resolve(frozen.delete()); return disposal }
  const alive = () => { epoch.assertCurrent(); if (disposed) throw new Error('Backup capture was released') }
  try {
    await assertGuestCurrent(binding)
    await binding.planner.open(); await binding.files.open()
    // Dynamic opening reads the saved schema; the ordinary Inspector class would upgrade an old layout
    const hasInspector = requiredInspector ? true : await Dexie.exists(inspector.name)
    const openedInspector = requiredInspector ? await requiredInspector.openDatabase() : hasInspector ? await inspector.open() : undefined
    const participants: LegacyParticipant[] = [{ kind: 'planner', database: binding.planner }, ...(openedInspector ? [{ kind: 'inspector' as const, database: openedInspector }] : []), { kind: 'files', database: binding.files }]
    const capture = await captureLegacyBranch(frozen, participants, epoch.signal)
    const check = async () => {
      alive(); await assertGuestCurrent(binding)
      if (hasInspector !== await Dexie.exists(inspector.name)) throw new WorkspaceBackupError('SNAPSHOT_CHANGED', 'Inspector storage changed during backup. Retry the export.')
      const comparison = await compareLegacyBranch(frozen, capture, participants, epoch.signal)
      await assertGuestCurrent(binding); alive()
      if (comparison.status !== 'equal') throw new WorkspaceBackupError('SNAPSHOT_CHANGED', 'The workspace changed during backup. Retry the export.')
    }
    const { state, sidecar } = await projectCapturedGuestState(frozen, capture, alive, check, binding.manifest.version === 2 ? 'journaled' : 'legacy')
    const snapshot: WorkspaceSnapshot = { version: 1, snapshotId: crypto.randomUUID(), capturedAt: new Date().toISOString(), revisionVector: { guest: binding.manifest.id, capture: capture.id, metadata: await backupMetadataDigest({ ...state, blobs: state.blobs.map(({ ref }) => ref) }) }, state }
    await validateWorkspaceSnapshot(snapshot)
    await check()
    return await joinWorkspaceSnapshotEvidence(ownWorkspaceSnapshot(snapshot, { check, dispose }), guestEvidenceSources(sidecar), { signal: epoch.signal })
  } catch (error) { await dispose(); throw error }
}

function assertSynchronousCaptureOwner(assertOwned: () => void): void {
  const result: unknown = assertOwned()
  if (result !== undefined) {
    // A void callback can return a rejected promise; observe it without granting async ownership
    void Promise.resolve(result).catch(() => {})
    throw new Error('Guest capture ownership assertion must be synchronous')
  }
}

function bindCapturedBody(content: BlobSource, guard: () => void): BlobSource {
  return { byteLength: content.byteLength, async *open() {
    guard()
    const iterator = content.open()[Symbol.asyncIterator]()
    try {
      for (;;) {
        guard()
        const result = await iterator.next()
        guard()
        if (result.done) return
        guard()
        yield result.value
        guard()
      }
    } finally { await iterator.return?.() }
  } }
}

/** Reads only a caller-owned frozen v2 target; no selected pointer or native target open is consulted */
export async function readUnselectedGuestCapture(
  frozen: LegacyCaptureDatabase,
  capture: LegacyCapture,
  target: import('zod').infer<typeof GuestManifestV2Schema>,
  assertOwned: () => void,
): Promise<{ state: WorkspaceState; inherited: InheritedSnapshotSources }> {
  const guard = () => assertSynchronousCaptureOwner(assertOwned)
  guard()
  const manifest = GuestManifestV2Schema.parse(target)
  if (manifest.planner !== `crykit-restored-v2-${manifest.id}-planner`
    || manifest.inspector !== `crykit-restored-v2-${manifest.id}-inspector`
    || manifest.files !== `crykit-restored-v2-${manifest.id}-files`) throw new Error('Guest target participant identity is invalid')
  const expected = [
    { kind: 'planner', name: manifest.planner, tables: PLANNER_TABLES },
    { kind: 'inspector', name: manifest.inspector, tables: INSPECTOR_TABLES },
    { kind: 'files', name: manifest.files, tables: FILE_TABLES },
  ]
  if (capture.version !== 1 || capture.completed !== true || Object.keys(capture).sort().join(',') !== 'completed,id,participants,version'
    || !Array.isArray(capture.participants) || capture.participants.length !== expected.length
    || capture.participants.some((participant, index) => Object.keys(participant).sort().join(',') !== 'kind,name,tables'
      || participant.kind !== expected[index].kind || participant.name !== expected[index].name
      || JSON.stringify(participant.tables) !== JSON.stringify(expected[index].tables))) throw new Error('Guest target capture association is invalid')
  const { state, sidecar } = await projectCapturedGuestState(frozen, capture, guard, async () => { guard() }, 'journaled')
  const source = guestEvidenceSources(sidecar)
  // Current and inherited body readers must retain the same frozen owner beyond this projection call
  const inherited: InheritedSnapshotSources = {
    members: source.members.map(member => ({ ...member, metadata: bindCapturedBody(member.metadata, guard) })),
    bodies: source.bodies.map(body => ({ ref: body.ref, content: bindCapturedBody(body.content, guard) })),
  }
  guard()
  return { state: { ...state, blobs: state.blobs.map(blob => ({ ref: blob.ref, content: bindCapturedBody(blob.content, guard) })) }, inherited }
}

/** Projects a retained recovery branch without consulting the selected pointer or reopening retired stores */
export async function readUnselectedGuestRecoveryCapture(frozen: LegacyCaptureDatabase, capture: LegacyCapture, assertOwned: () => void): Promise<{ state: WorkspaceState; inherited: InheritedSnapshotSources; destinationChanges: WorkspaceState['planner']['localData']['changes'] }> {
  const guard = () => assertSynchronousCaptureOwner(assertOwned)
  guard()
  const participants = capture.participants
  if (capture.version !== 1 || !capture.completed || participants.length !== 3
    || participants.map(value => value.kind).join(',') !== 'planner,inspector,files'
    || participants.some(value => !value.name || new Set(value.tables).size !== value.tables.length)) throw new Error('Retained recovery capture association is invalid')
  // Restored target names require journaled rows; older retained branches keep their legacy planner layout
  const mode = participants[0].name.startsWith('crykit-restored-v2-') ? 'journaled' : 'legacy'
  const { state, sidecar, destinationChanges } = await projectCapturedGuestState(frozen, capture, guard, async () => { guard() }, mode, true)
  const source = guestEvidenceSources(sidecar)
  const inherited: InheritedSnapshotSources = {
    members: source.members.map(member => ({ ...member, metadata: bindCapturedBody(member.metadata, guard) })),
    bodies: source.bodies.map(body => ({ ref: body.ref, content: bindCapturedBody(body.content, guard) })),
  }
  guard()
  return { state: { ...state, blobs: state.blobs.map(blob => ({ ref: blob.ref, content: bindCapturedBody(blob.content, guard) })) }, inherited, destinationChanges }
}
