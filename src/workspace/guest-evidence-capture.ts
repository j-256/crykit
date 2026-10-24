import { readGuestEvidence, prepareEmptyGuestEvidence, GUEST_FILES_V1_STORES, GUEST_EVIDENCE_STORES, GUEST_EXTENSION_KEY, type CapturedGuestEvidence } from './guest-evidence'
import { readLegacyCapture, type LegacyCaptureDatabase, type LegacyCapture } from './legacy-capture'

// Only compact locators are retained; metadata segments and native chunks remain in the owned freeze
export async function readCapturedGuestEvidence(database: LegacyCaptureDatabase, capture: LegacyCapture, check: () => Promise<void>, allowLegacyEmpty = false, assertOwned?: () => void): Promise<CapturedGuestEvidence> {
  const files = capture.participants.find(participant => participant.kind === 'files')
  if (!files) throw new Error('The captured files participant is missing')
  const indexes = new Map<string, Map<string, { key: IDBValidKey; ordinal: number }>>(files.tables.map(table => [table, new Map()]))
  const iterator = readLegacyCapture(database, capture)[Symbol.asyncIterator]()
  try {
    for (;;) {
      // The captured owner can retire while a frozen row request is pending
      assertOwned?.()
      const result = await iterator.next()
      assertOwned?.()
      if (result.done) break
      const row = result.value
      if (row.participant === 'files' && row.kind === 'record') {
        if (row.key === undefined) throw new Error('Missing captured files key')
        indexes.get(row.table)!.set(JSON.stringify(row.key), { key: row.key, ordinal: row.ordinal })
      }
    }
  } finally { await iterator.return?.() }
  // Recovery alone may interpret a validated legacy absence as the explicit empty extension
  // A partial v2 layout or a legacy extension declaration must never become an empty history
  const legacy = allowLegacyEmpty && JSON.stringify([...files.tables].sort()) === JSON.stringify(Object.keys(GUEST_FILES_V1_STORES).sort())
  if (legacy && indexes.get('documents')!.has(JSON.stringify(GUEST_EXTENSION_KEY))) throw new Error('Unsupported legacy evidence declaration')
  const initialized = legacy ? await prepareEmptyGuestEvidence() : []
  const emptyRows = new Map<string, Map<string, { key: string }>>()
  for (const { table, row } of initialized) { if (!emptyRows.has(table)) emptyRows.set(table, new Map()); const value = row as { key: string }; emptyRows.get(table)!.set(JSON.stringify(value.key), value) }
  return readGuestEvidence({ tables: legacy ? [...files.tables, ...Object.keys(GUEST_EVIDENCE_STORES)] : files.tables, async keys(table) { assertOwned?.(); return [...(indexes.get(table)?.values() ?? []), ...(emptyRows.get(table)?.values() ?? [])].map(row => row.key) }, async get(table, key) {
    assertOwned?.()
    const initialized = emptyRows.get(table)?.get(JSON.stringify(key))
    if (initialized) return initialized
    const locator = indexes.get(table)?.get(JSON.stringify(key))
    if (!locator) return undefined
    const row = await database.records.get([capture.id, locator.ordinal])
    assertOwned?.()
    if (!row || row.participant !== 'files' || row.table !== table || JSON.stringify(row.key) !== JSON.stringify(key)) throw new Error('Captured files evidence disappeared')
    return row.value
  } }, check)
}
