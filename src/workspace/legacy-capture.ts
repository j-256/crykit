import Dexie, { type Table } from 'dexie'
import { encodeLegacyValue, equalLegacyValue, LEGACY_CAPTURE_CODEC_VERSION } from './legacy-value'
import { GUEST_BARRIER_KEY } from './guest-barrier'
import { readInspectorFileInfo } from '../mod-inspector/file-info-contract'

export const LEGACY_CHECK_BUDGET_MS = 30_000
export const LEGACY_MONITOR_INTERVAL_MS = 30_000
const COMPARISON_SLICE_BYTES = 64 * 1024
const COMPARISON_SLICE_PARTS = 4096
export type GuestParticipantKind = 'planner' | 'inspector' | 'files'
export interface LegacyParticipant { readonly kind: GuestParticipantKind; readonly database: Dexie; readonly barrierOwner?: string }
export interface LegacyCapture {
  readonly id: string
  readonly version: typeof LEGACY_CAPTURE_CODEC_VERSION
  readonly participants: readonly { readonly kind: GuestParticipantKind; readonly name: string; readonly tables: readonly string[] }[]
  readonly completed: boolean
}
export interface LegacyCaptureRecord { readonly captureId: string; readonly ordinal: number; readonly participant: GuestParticipantKind; readonly table: string; readonly kind: 'record' | 'table-end'; readonly key?: IDBValidKey; readonly value?: unknown }
export interface LegacyScanMetrics { rows: number; bytes: number; peakRecordBytes: number; durationMs: number; heartbeatRequests: number }
export type LegacyComparison = { readonly status: 'equal' | 'diverged'; readonly metrics: LegacyScanMetrics } | { readonly status: 'incomplete'; readonly reason: 'cancelled' | 'unavailable'; readonly metrics: LegacyScanMetrics }
export class LegacyCaptureDatabase extends Dexie {
  captures!: Table<LegacyCapture, string>
  records!: Table<LegacyCaptureRecord, [string, number]>
  constructor(name = 'crykit-guest-captures-v1') { super(name); this.version(1).stores({ captures: 'id', records: '[captureId+ordinal], captureId' }) }
}
interface HeldReader { readonly participant: LegacyParticipant; readonly tables: readonly string[]; readonly acquired: Promise<void>; readonly completed: Promise<void>; readonly transaction: IDBTransaction; schedule(action: () => void): void; onFailure(callback: (error: unknown) => void): () => void; stop(abort: boolean): void; assertAlive(): void }
export interface HeldLegacyReaders { readonly readers: readonly HeldReader[]; readonly metrics: LegacyScanMetrics; scan(visitor: (record: Omit<LegacyCaptureRecord, 'captureId' | 'ordinal'>) => Promise<void>): Promise<void>; assertAlive(): void; yieldWork(): Promise<void>; release(abort?: boolean): Promise<void> }

export async function holdLegacyReaders(participants: readonly LegacyParticipant[], signal?: AbortSignal): Promise<HeldLegacyReaders> {
  const started = performance.now()
  const metrics: LegacyScanMetrics = { rows: 0, bytes: 0, peakRecordBytes: 0, durationMs: 0, heartbeatRequests: 0 }
  const readers: HeldReader[] = []
  let released = false
  let interrupt!: (reason: unknown) => void
  const interrupted = new Promise<never>((_resolve, reject) => { interrupt = reject })
  void interrupted.catch(() => {})
  const check = () => { if (signal?.aborted) throw new Error('Legacy check cancelled'); if (performance.now() - started >= LEGACY_CHECK_BUDGET_MS) throw new Error('Legacy check budget exceeded') }
  const abort = () => { interrupt(new Error('Legacy check interrupted')); for (const reader of [...readers].reverse()) reader.stop(true) }
  const deadline = setTimeout(abort, LEGACY_CHECK_BUDGET_MS)
  signal?.addEventListener('abort', abort, { once: true })
  try {
    for (const participant of participants) {
      check()
      await Promise.race([participant.database.open(), interrupted])
      const native = participant.database.backendDB(), tables = [...native.objectStoreNames].sort()
      if (!tables.length) throw new Error('Legacy participant has no readable tables')
      const transaction = native.transaction(tables, 'readonly')
      let active = true, stopping = false, failure: unknown
      const actions: (() => void)[] = []
      const failures = new Set<(error: unknown) => void>()
      let acquiredResolve!: () => void, acquiredReject!: (reason: unknown) => void
      const acquired = new Promise<void>((resolve, reject) => { acquiredResolve = resolve; acquiredReject = reject })
      let completeResolve!: () => void, completeReject!: (reason: unknown) => void
      const completed = new Promise<void>((resolve, reject) => { completeResolve = resolve; completeReject = reject })
      void completed.catch(() => {})
      const assertAlive = () => { check(); if (failure || !active || stopping) throw failure ?? new Error('Legacy source transaction ended') }
      const fail = (error: unknown) => { failure = error; acquiredReject(error); try { transaction.abort() } catch { /* Reconciliation treats an already-ended reader as incomplete */ } }
      transaction.onabort = () => { active = false; const error = failure ?? transaction.error ?? new Error('Legacy reader aborted'); acquiredReject(error); completeReject(error); for (const callback of failures) callback(error) }
      transaction.oncomplete = () => { active = false; if (!stopping) { failure = new Error('Legacy reader ended unexpectedly'); acquiredReject(failure); completeReject(failure); for (const callback of failures) callback(failure) } else completeResolve() }
      const pump = () => {
        if (stopping) return
        try {
          assertAlive()
          const request = transaction.objectStore(tables[0]).get('\u0000crykit-held-reader')
          metrics.heartbeatRequests++
          request.onsuccess = () => {
            if (stopping) return
            try {
              assertAlive(); acquiredResolve()
              for (const action of actions.splice(0)) action()
              pump()
            } catch (error) { fail(error) }
          }
          request.onerror = () => fail(request.error)
        } catch (error) { fail(error) }
      }
      const reader: HeldReader = { participant, tables, transaction, acquired, completed, assertAlive, onFailure(callback) { failures.add(callback); return () => { failures.delete(callback) } }, schedule(action) { assertAlive(); actions.push(action) }, stop(abort) { if (!active || stopping) return; stopping = true; if (abort) { failure = new Error('Legacy check cancelled'); try { transaction.abort() } catch { /* The actual transaction result remains authoritative */ } } } }
      readers.push(reader); pump(); await acquired
    }
    const held: HeldLegacyReaders = {
      readers, metrics,
      assertAlive() { check(); for (const reader of readers) reader.assertAlive() },
      yieldWork() { return new Promise<void>((resolve, reject) => {
        const unsubscribe = readers[0].onFailure(error => { unsubscribe(); reject(error) })
        try { readers[0].schedule(() => { unsubscribe(); resolve() }) } catch (error) { unsubscribe(); reject(error) }
      }) },
      async scan(visitor) {
        for (const reader of readers) {
          let barrierSeen = false
          for (const table of reader.tables) {
            await new Promise<void>((resolve, reject) => {
              const failed = (error: unknown) => reject(error)
              void reader.completed.catch(failed)
              reader.schedule(() => {
                const request = reader.transaction.objectStore(table).openCursor()
                request.onerror = () => reject(request.error)
                request.onsuccess = () => {
                  try {
                    held.assertAlive()
                    const cursor = request.result
                    if (!cursor) { resolve(); return }
                    const { key, value } = cursor
                    const next = () => reader.schedule(() => cursor.continue())
                    if (table === 'meta' && key === GUEST_BARRIER_KEY) {
                      const row = value as { key?: unknown; value?: unknown }
                      if (!reader.participant.barrierOwner || Object.keys(row).sort().join(',') !== 'key,value' || row.key !== GUEST_BARRIER_KEY || row.value !== reader.participant.barrierOwner) throw new Error('Legacy barrier ownership is unavailable or changed')
                      barrierSeen = true; next(); return
                    }
                    void (async () => {
                      let bytes = 0, sliceBytes = 0, parts = 0
                      for (const part of encodeLegacyValue([key, value])) {
                        check(); bytes += part.length; sliceBytes += part.length
                        if (sliceBytes >= COMPARISON_SLICE_BYTES || ++parts >= COMPARISON_SLICE_PARTS) { sliceBytes = 0; parts = 0; await held.yieldWork() }
                      }
                      metrics.rows++; metrics.bytes += bytes; metrics.peakRecordBytes = Math.max(metrics.peakRecordBytes, bytes)
                      // Only one logical cursor value and its destination clone are in flight
                      await visitor({ participant: reader.participant.kind, table, kind: 'record', key, value })
                      next()
                    })().catch(reject)
                  } catch (error) { reject(error) }
                }
              })
            })
            await visitor({ participant: reader.participant.kind, table, kind: 'table-end' })
          }
          if (reader.participant.barrierOwner && !barrierSeen) throw new Error('Legacy write barrier is missing')
        }
        held.assertAlive()
      },
      async release(abort = false) {
        if (released) return
        released = true; signal?.removeEventListener('abort', abortListener); clearTimeout(deadline)
        for (const reader of [...readers].reverse()) reader.stop(abort)
        const results = await Promise.allSettled(readers.map(reader => reader.completed))
        metrics.durationMs = performance.now() - started
        if (!abort) for (const result of results) if (result.status === 'rejected') throw result.reason
      },
    }
    const abortListener = abort
    return held
  } catch (error) { abort(); clearTimeout(deadline); signal?.removeEventListener('abort', abort); await Promise.allSettled(readers.map(reader => reader.completed)); throw error }
}

function comparable(record: Omit<LegacyCaptureRecord, 'captureId' | 'ordinal'>): unknown {
  if (record.participant !== 'inspector' || record.table !== 'drafts' || !record.value || typeof record.value !== 'object') return record
  const value = record.value as Record<string, unknown>, cache = value.fileInfo
  const known = ['schemaVersion', 'edited', 'title', 'version', 'projectId', 'titleState', 'versionState', 'projectIdState']
  if (!cache || typeof cache !== 'object' || Object.keys(cache).some(key => !known.includes(key)) || !readInspectorFileInfo(cache)) return record
  const { fileInfo: _cache, ...content } = value
  return { ...record, value: content }
}

export async function captureLegacyBranch(database: LegacyCaptureDatabase, participants: readonly LegacyParticipant[], signal?: AbortSignal): Promise<LegacyCapture> {
  const held = await holdLegacyReaders(participants, signal)
  const capture: LegacyCapture = { version: 1, id: crypto.randomUUID(), completed: false, participants: held.readers.map(reader => ({ kind: reader.participant.kind, name: reader.participant.database.name, tables: reader.tables })) }
  try {
    await database.captures.add(capture)
    let ordinal = 0
    await held.scan(async record => { await database.records.add({ ...record, captureId: capture.id, ordinal: ordinal++ }) })
    held.assertAlive()
    await held.release()
    await database.captures.put({ ...capture, completed: true })
    return { ...capture, completed: true }
  } catch (error) { await held.release(true); throw error }
}

export async function compareHeldLegacyBranch(database: LegacyCaptureDatabase, capture: LegacyCapture, held: HeldLegacyReaders): Promise<boolean> {
  if (capture.version !== LEGACY_CAPTURE_CODEC_VERSION || !capture.completed) throw new Error('Legacy capture is incomplete or unsupported')
  const identity = held.readers.map(reader => ({ kind: reader.participant.kind, name: reader.participant.database.name, tables: reader.tables }))
  if (!equalLegacyValue(capture.participants, identity)) return false
  let ordinal = 0, equal = true
  await held.scan(async record => {
    const saved = await database.records.get([capture.id, ordinal++])
    if (!saved) { equal = false; return }
    const { captureId: _captureId, ordinal: _ordinal, ...before } = saved
    const left = encodeLegacyValue(comparable(before))[Symbol.iterator](), right = encodeLegacyValue(comparable(record))[Symbol.iterator]()
    let sliceBytes = 0, parts = 0
    try {
      while (true) {
        const a = left.next(), b = right.next()
        if (a.done || b.done) { if (!a.done || !b.done) equal = false; break }
        if (a.value.length !== b.value.length || a.value.some((byte, index) => byte !== b.value[index])) { equal = false; break }
        sliceBytes += a.value.length
        if (sliceBytes >= COMPARISON_SLICE_BYTES || ++parts >= COMPARISON_SLICE_PARTS) { sliceBytes = 0; parts = 0; await held.yieldWork() }
      }
    } finally { left.return?.(); right.return?.() }
  })
  if (await database.records.get([capture.id, ordinal])) equal = false
  held.assertAlive()
  return equal
}
export async function compareLegacyBranch(database: LegacyCaptureDatabase, capture: LegacyCapture, participants: readonly LegacyParticipant[], signal?: AbortSignal): Promise<LegacyComparison> {
  let held: HeldLegacyReaders | undefined
  try {
    held = await holdLegacyReaders(participants, signal)
    const equal = await compareHeldLegacyBranch(database, capture, held)
    await held.release()
    return { status: equal ? 'equal' : 'diverged', metrics: held.metrics }
  } catch {
    await held?.release(true)
    return { status: 'incomplete', reason: signal?.aborted ? 'cancelled' : 'unavailable', metrics: held?.metrics ?? { rows: 0, bytes: 0, peakRecordBytes: 0, durationMs: 0, heartbeatRequests: 0 } }
  }
}

export async function* readLegacyCapture(database: LegacyCaptureDatabase, capture: LegacyCapture): AsyncIterable<LegacyCaptureRecord> {
  const saved = await database.captures.get(capture.id)
  if (!saved?.completed || saved.version !== LEGACY_CAPTURE_CODEC_VERSION || !equalLegacyValue(saved, capture)) throw new Error('Legacy capture is incomplete or changed')
  let ordinal = 0
  const participants = new Set<string>()
  for (const participant of capture.participants) {
    if (participants.has(participant.kind) || !['planner', 'inspector', 'files'].includes(participant.kind) || new Set(participant.tables).size !== participant.tables.length) throw new Error('Legacy capture has contradictory participants')
    participants.add(participant.kind)
    for (const table of participant.tables) {
      let previous: IDBValidKey | undefined
      for (;;) {
        const row = await database.records.get([capture.id, ordinal])
        if (!row || row.captureId !== capture.id || row.ordinal !== ordinal || row.participant !== participant.kind || row.table !== table) throw new Error('Legacy capture is incomplete or out of order')
        const keys = Object.keys(row).sort().join(',')
        if (row.kind === 'table-end') {
          if (keys !== 'captureId,kind,ordinal,participant,table') throw new Error('Malformed legacy table terminator')
          ordinal++; yield row; break
        }
        if (row.kind !== 'record' || keys !== 'captureId,key,kind,ordinal,participant,table,value' || row.key === undefined || previous !== undefined && indexedDB.cmp(previous, row.key) >= 0) throw new Error('Malformed legacy capture record')
        previous = row.key; ordinal++; yield row
      }
    }
  }
  // A missing cursor row cannot silently truncate a recovery export or prepared replacement
  if (await database.records.where('captureId').equals(capture.id).count() !== ordinal) throw new Error('Legacy capture has trailing or missing records')
}
