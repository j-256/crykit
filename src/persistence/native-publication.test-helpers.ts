import type { ProfileToken } from '../account/profile'
import { BUNDLED_CATALOGS } from '../catalog/bundled'
import { createBlankLocalData } from '../domain/local-data'
import { accountLocalId } from '../workspace/account-cache'
import { prepareAccountWorkspace } from '../workspace/account-graph'
import { activateLocalAccountCommit, type AccountDatabase } from './account-database'

// Publication codec subjects start with real native ciphertext rather than the fresh managed app layout
export async function seedNativePublicationWorkspace(database: AccountDatabase, token: ProfileToken) {
  const localData = createBlankLocalData()
  const prepared = await prepareAccountWorkspace(database, token, { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: BUNDLED_CATALOGS, evidence: [], sources: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], libraryDefaults: { version: 1, layers: [] }, conflicts: [], retainedContent: [], blobs: [] })
  await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: undefined, head: prepared.head, records: prepared.records })
}
