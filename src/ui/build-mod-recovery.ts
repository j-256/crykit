import { buildBehavior } from '../domain/build-behavior'
import { buildContentForModSetup } from '../domain/build-mods'
import { sameValue } from '../domain/definition-values'
import { modCatalogRevision } from '../domain/mod-layers'
import type { BuildRevisionContent, CatalogSnapshot, GameSetupRevision, LocalData } from '../domain/types'
import { prepareLocalBuildModRecovery } from '../interchange/share-mod-recovery'

// Draft recovery uses exact shared source matching without projecting through a legacy public format
// Saving a new checkpoint remains a separate user action
export function prepareBuildModRecovery(content: BuildRevisionContent, setup: GameSetupRevision, localData: LocalData, catalogs: readonly CatalogSnapshot[]) {
  const composition = setup.modComposition
  const origin = composition && Object.values(localData.gameSetups).find(candidate => modCatalogRevision(candidate.id) === setup.catalogLock[composition.baseline.catalogId] && sameValue(candidate.modComposition, composition))
  // A draft can retain its source setup's effective pin until its behavior changes
  // Give recovery one owner for that pin so its content and setup rebind together
  const sourceSetup = origin ? { ...setup, id: origin.id } : setup
  const recovery = prepareLocalBuildModRecovery(content, sourceSetup, catalogs)
  if (!recovery.draft) return { ...recovery, draft: undefined }
  const recovered = recovery.draft
  const recoveredSetup = recovered.setup
  const previous = buildBehavior(recoveredSetup)
  const baseline = previous.modComposition?.baseline.catalogId
  const behavior = { ...previous, catalogLock: { ...previous.catalogLock, ...(baseline ? { [baseline]: modCatalogRevision(setup.id) } : {}) } }
  // The editor owns a stable temporary setup identity, distinct from the recovery preview's identity
  return { ...recovery, draft: { content: buildContentForModSetup(recovered.content, behavior, catalogs, previous), behavior } }
}
