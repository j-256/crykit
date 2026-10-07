import type { GameSetupRevisionId, LocalData } from '../domain/types'

export function buildStartingSetup(localData: LocalData, explicitId?: GameSetupRevisionId | string) {
  if (explicitId) return { id: explicitId, description: 'Using the requested Game Setup.' }
  const previousBuild = Object.values(localData.builds)
    .filter(build => !build.archived && !build.tags.includes('sample') && build.latestRevisionId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]
  const previousRevision = previousBuild?.latestRevisionId ? localData.buildRevisions[previousBuild.latestRevisionId] : undefined
  if (previousRevision) return { id: previousRevision.gameSetupRevisionId, description: `Starting with the Game Setup from ${previousBuild!.title}. Review its rules below.` }
  return { id: localData.planningGameSetupRevisionId, description: 'Starts with your planning Game Setup. Review its rules before choosing equipment.' }
}
