import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { expect, it } from 'vitest'
import { LegacyCaptureDatabase, captureLegacyBranch, compareLegacyBranch, holdLegacyReaders } from '../workspace/legacy-capture'

it('freezes exact history and detects same-count edits and deletion/recreation in fresh all-store scans', async () => {
  const source = new Dexie(`legacy-source-${crypto.randomUUID()}`)
  source.version(1).stores({ records: 'id', history: 'id', meta: 'key' })
  const captures = new LegacyCaptureDatabase(`legacy-capture-${crypto.randomUUID()}`)
  const participants = [{ kind: 'planner' as const, database: source }]
  try {
    await source.table('records').put({ id: 'one', revision: 1, text: '\ud800', original: new Uint8Array([0, 255]) })
    await source.table('history').put({ id: 'old', text: 'frozen history' })
    const capture = await captureLegacyBranch(captures, participants)
    expect((await compareLegacyBranch(captures, capture, participants)).status).toBe('equal')
    await source.table('records').put({ id: 'one', revision: 1, text: '\ud801', original: new Uint8Array([0, 255]) })
    expect((await compareLegacyBranch(captures, capture, participants)).status).toBe('diverged')
    await source.table('history').delete('old')
    expect((await captures.records.where('captureId').equals(capture.id).toArray()).some(row => row.table === 'history' && (row.value as { text?: string })?.text === 'frozen history')).toBe(true)
    await source.table('records').clear(); await source.table('records').put({ id: 'recreated', revision: 1, text: '\ud800', original: new Uint8Array([0, 255]) })
    expect((await compareLegacyBranch(captures, capture, participants)).status).toBe('diverged')
  } finally { await source.delete(); await captures.delete() }
})
it('keeps overlapping acquired readers alive until released and cancellation cannot report clean', async () => {
  const source = new Dexie(`legacy-held-${crypto.randomUUID()}`)
  source.version(1).stores({ records: 'id', meta: 'key' })
  const captures = new LegacyCaptureDatabase(`legacy-cancel-${crypto.randomUUID()}`)
  try {
    await source.table('records').put({ id: 'one', text: 'original' })
    const participants = [{ kind: 'planner' as const, database: source }]
    const capture = await captureLegacyBranch(captures, participants)
    const controller = new AbortController()
    const held = await holdLegacyReaders(participants, controller.signal)
    let written = false
    const write = source.table('records').put({ id: 'one', text: 'later' }).then(() => { written = true })
    expect(written).toBe(false)
    await held.release()
    await write
    controller.abort()
    expect((await compareLegacyBranch(captures, capture, participants, controller.signal)).status).toBe('incomplete')
  } finally { await source.delete(); await captures.delete() }
})

it('validates narrow control ownership and treats unknown metadata as retained content', async () => {
  const { GUEST_BARRIER_KEY } = await import('../workspace/guest-barrier')
  const source = new Dexie(`legacy-control-${crypto.randomUUID()}`)
  source.version(1).stores({ records: 'id', meta: 'key' })
  const captures = new LegacyCaptureDatabase(`legacy-controls-${crypto.randomUUID()}`)
  try {
    await source.table('meta').put({ key: 'unknown-existing', value: { exact: undefined } })
    const participants = [{ kind: 'planner' as const, database: source }]
    const capture = await captureLegacyBranch(captures, participants)
    const owned = [{ ...participants[0], barrierOwner: 'owned' }]
    expect((await compareLegacyBranch(captures, capture, owned)).status).toBe('incomplete')
    await source.table('meta').put({ key: GUEST_BARRIER_KEY, value: 'owned' })
    expect((await compareLegacyBranch(captures, capture, owned)).status).toBe('equal')
    await source.table('meta').put({ key: GUEST_BARRIER_KEY, value: 'other' })
    expect((await compareLegacyBranch(captures, capture, owned)).status).toBe('incomplete')
    await source.table('meta').put({ key: GUEST_BARRIER_KEY, value: 'owned', unknown: true })
    expect((await compareLegacyBranch(captures, capture, owned)).status).toBe('incomplete')
    await source.table('meta').put({ key: GUEST_BARRIER_KEY, value: 'owned' })
    await source.table('meta').put({ key: 'unknown-existing', value: { exact: null } })
    expect((await compareLegacyBranch(captures, capture, owned)).status).toBe('diverged')
  } finally { await source.delete(); await captures.delete() }
})

it('rejects a completed capture with a missing table terminator during retained replay', async () => {
  const { readLegacyCapture } = await import('../workspace/legacy-capture')
  const source = new Dexie(`legacy-replay-${crypto.randomUUID()}`)
  source.version(1).stores({ values: 'id' })
  const captureDatabase = new LegacyCaptureDatabase(`legacy-replay-capture-${crypto.randomUUID()}`)
  try {
    await source.table('values').put({ id: 'one', exact: 'retained' })
    const capture = await captureLegacyBranch(captureDatabase, [{ kind: 'planner', database: source }])
    const rows = []; for await (const row of readLegacyCapture(captureDatabase, capture)) rows.push(row)
    expect(rows).toHaveLength(2)
    await captureDatabase.records.delete([capture.id, 1])
    const replay = async () => { for await (const _row of readLegacyCapture(captureDatabase, capture)) { /* Consume validated records */ } }
    await expect(replay()).rejects.toThrow('incomplete')
  } finally { await source.delete(); await captureDatabase.delete() }
})
