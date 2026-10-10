import { buildBehavior } from '../domain/build-behavior'
import { buildContentForModSetup } from '../domain/build-mods'
import { createId } from '../domain/core'
import { sameValue } from '../domain/definition-values'
import { modCatalogRevision } from '../domain/mod-layers'
import type { Build, BuildId, BuildRevision, BuildRevisionContent, BuildRevisionId, CatalogSnapshot, GameSetupRevision, LocalData } from '../domain/types'
import { createSharePayload } from '../interchange/share'
import { prepareSharedModRecovery } from '../interchange/share-mod-recovery'

// Use the shared recovery contract for draft-only interpretation changes as well
// Temporary records never enter persistence; saving a new checkpoint is a separate user action
export function prepareBuildModRecovery(content: BuildRevisionContent, setup: GameSetupRevision, localData: LocalData, catalogs: readonly CatalogSnapshot[]) {
  const composition = setup.modComposition
  const origin = composition && Object.values(localData.gameSetups).find(candidate => modCatalogRevision(candidate.id) === setup.catalogLock[composition.baseline.catalogId] && sameValue(candidate.modComposition, composition))
  // A draft can retain its source setup's effective pin until its behavior changes
  // Give recovery one owner for that pin so its content and setup rebind together
  const sourceSetup = origin ? { ...setup, id: origin.id } : setup
  const id = createId<BuildId>('build')
  const revisionId = createId<BuildRevisionId>('buildRevision')
  const build: Build = { id, revision: 1, gameSetupId: setup.gameSetupId, title: 'Build recovery', archived: false, tags: [], favorite: false, latestRevisionId: revisionId, createdAt: localData.createdAt, updatedAt: localData.updatedAt }
  const revision: BuildRevision = { id: revisionId, buildId: id, revision: 1, gameSetupRevisionId: sourceSetup.id, catalogLock: setup.catalogLock, content, createdAt: localData.createdAt }
  const data = { ...localData, builds: { ...localData.builds, [id]: build }, buildRevisions: { ...localData.buildRevisions, [revisionId]: revision }, gameSetups: { ...localData.gameSetups, [sourceSetup.id]: sourceSetup } }
  const recovery = prepareSharedModRecovery(createSharePayload(data, { kind: 'build', revisionId }, true, catalogs), catalogs)
  if (!recovery.payload) return { ...recovery, draft: undefined }
  const recovered = recovery.payload.records.buildRevisions[revisionId]!
  const recoveredSetup = recovery.payload.records.gameSetups[recovered.gameSetupRevisionId]!
  const previous = buildBehavior(recoveredSetup)
  const baseline = previous.modComposition?.baseline.catalogId
  const behavior = { ...previous, catalogLock: { ...previous.catalogLock, ...(baseline ? { [baseline]: modCatalogRevision(setup.id) } : {}) } }
  // The editor owns a stable temporary setup identity, distinct from the recovery preview's identity
  return { ...recovery, draft: { content: buildContentForModSetup(recovered.content, behavior, catalogs, previous), behavior } }
}
