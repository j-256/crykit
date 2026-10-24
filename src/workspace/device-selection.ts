import Dexie, { type EntityTable } from 'dexie'
import { z } from 'zod'
import { OpaqueIdSchema } from '../account/protocol'

const DeviceSelectionSchema = z.discriminatedUnion('kind', [
  z.object({ key: z.literal('selected'), version: z.literal(1), kind: z.literal('guest') }).strict(),
  z.object({ key: z.literal('selected'), version: z.literal(1), kind: z.literal('account'), accountId: OpaqueIdSchema }).strict(),
])
export type DeviceSelection = z.infer<typeof DeviceSelectionSchema>
class SelectionDatabase extends Dexie {
  selection!: EntityTable<DeviceSelection, 'key'>
  constructor() { super('crykit-workspace-selection-v1'); this.version(1).stores({ selection: 'key' }) }
}
export async function readDeviceSelection(): Promise<DeviceSelection | undefined> {
  const database = new SelectionDatabase()
  try { const value = await database.selection.get('selected'); return value === undefined ? undefined : DeviceSelectionSchema.parse(value) }
  finally { database.close() }
}
export async function writeDeviceSelection(value: DeviceSelection, assertCurrent: () => void): Promise<void> {
  const selection = DeviceSelectionSchema.parse(value)
  const database = new SelectionDatabase()
  try {
    await database.transaction('rw', database.selection, async () => {
      assertCurrent()
      await database.selection.put(selection)
      assertCurrent()
    })
    assertCurrent()
  } finally { database.close() }
}
