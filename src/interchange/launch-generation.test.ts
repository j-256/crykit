import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import { createBlankLocalData } from '../domain/local-data'
import { LAUNCH_DATA_GENERATION } from '../domain/data-generation'
import { NativeLocalDataSchema, StoredNativeLocalDataSchema, NativeManifestSchema, NativePayloadSchema } from './native-schema'
import { LocalWorkspaceRootV3Schema } from '../workspace/local-root'
import { AccountWorkspaceRootV1Schema, AccountWorkspaceRootV2Schema } from '../workspace/account-graph'
import { BackupFrameSchema, BackupManifestV2Schema, SnapshotHeaderSchema } from './workspace-backup-schema'

it('initializes the launch generation and rejects prelaunch planner data without migration', () => {
  const local = createBlankLocalData()
  expect(local.schemaVersion).toBe('3.0.0')
  expect(local.dataGeneration).toBe(LAUNCH_DATA_GENERATION)
  expect(NativeLocalDataSchema.safeParse(local).success).toBe(true)
  const { dataGeneration: _generation, ...old } = local
  for (const schemaVersion of ['2.0.0', '2.1.0', '2.2.0', '2.3.0', '2.4.0', '2.5.0', '3.0.0']) {
    expect(StoredNativeLocalDataSchema.safeParse({ ...old, schemaVersion }).success).toBe(false)
  }
  expect(NativeLocalDataSchema.safeParse({ ...local, dataGeneration: 'unsupported-generation' }).success).toBe(false)
})

it('requires the same explicit generation on every durable plaintext root', () => {
  for (const schema of [LocalWorkspaceRootV3Schema, AccountWorkspaceRootV1Schema, AccountWorkspaceRootV2Schema, NativeManifestSchema, BackupFrameSchema.options[1], BackupManifestV2Schema, SnapshotHeaderSchema]) {
    expect(schema.shape.dataGeneration.safeParse(LAUNCH_DATA_GENERATION).success).toBe(true)
    expect(schema.shape.dataGeneration.safeParse(undefined).success).toBe(false)
    expect(schema.shape.dataGeneration.safeParse('prelaunch').success).toBe(false)
  }
})

it('rejects backup formats that rely on the installed package to provide source bodies', () => {
  const localData = createBlankLocalData()
  const payload = { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [], evidence: [], history: [] }
  expect(NativePayloadSchema.safeParse(payload).success).toBe(true)
  expect(NativePayloadSchema.safeParse({ ...payload, bundledCatalogs: [] }).success).toBe(false)
})

it('diagnoses prelaunch complete backups before reading their content', async () => {
  const { readWorkspaceBackup } = await import('./workspace-backup')
  let closed = false
  async function* prelaunch() {
    try {
      yield new TextEncoder().encode('CRYKIT-WORKSPACE/1\n')
      throw new Error('Prelaunch contents must not be read')
    } finally { closed = true }
  }
  await expect(readWorkspaceBackup(prelaunch())).rejects.toMatchObject({ code: 'UNSUPPORTED_VERSION' })
  expect(closed).toBe(true)
})
