import 'fake-indexeddb/auto'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import Dexie from 'dexie'
import { memoryBlob } from '../workspace/blobs'
import { readWorkspaceBackup } from './workspace-backup'

const required = ['mapping-control-baseline', 'personal-lineage', 'conflict-successor', 'build-copy', 'unavailable-source', 'historical-pins']
const fixtures = JSON.parse(readFileSync(new URL('./workspace-backup-v1.fixtures.json', import.meta.url), 'utf8')) as { name?: string; archive: string; metadata: unknown }[]

it('keeps the frozen prelaunch archive categories available for rejection coverage', () => {
  expect(fixtures.map(fixture => fixture.name).filter(Boolean)).toEqual(expect.arrayContaining(required))
})

// The generation gate must reject before semantic admission or native staging
// Supported closure and independently rehashed corruption coverage lives in workspace-graph and workspace-backup-evidence
it.each(fixtures)('rejects a prelaunch archive without changing its bytes or allocating staging: $name', async fixture => {
  const bytes = new Uint8Array(Buffer.from(fixture.archive, 'base64')), original = bytes.slice()
  const names = (await Dexie.getDatabaseNames()).sort()
  await expect(readWorkspaceBackup(memoryBlob(bytes).open())).rejects.toMatchObject({ code: 'UNSUPPORTED_VERSION' })
  expect(bytes).toEqual(original)
  expect((await Dexie.getDatabaseNames()).sort()).toEqual(names)
})
