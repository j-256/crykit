import { logicalEntityKey, validateBuildContent } from '../domain'
import { SUGGESTED_BUILD_SLOTS } from '../domain/build-planning'
import { equipmentFacts, equipmentRole } from '../domain/mechanics-facts'
import { TEAM_SIZE } from '../domain/scenarios'
import type { BuildRevision, BuildRevisionId, CatalogSnapshot, LocalData } from '../domain/types'
import { Badge } from './components'
import { resolveEntity } from './model'

export function newerTeamCheckpoint(localData: LocalData, revision: BuildRevision): BuildRevision | undefined {
  const latestId = localData.builds[revision.buildId]?.latestRevisionId
  const latest = latestId ? localData.buildRevisions[latestId] : undefined
  return latest && latest.buildId === revision.buildId && latest.revision > revision.revision ? latest : undefined
}

export function reviewTeam(slots: readonly (BuildRevisionId | null)[], localData: LocalData, catalogs: readonly CatalogSnapshot[]) {
  const members = slots.flatMap(id => {
    const revision = id ? localData.buildRevisions[id] : undefined
    if (!revision) return []
    const setup = localData.gameSetups[revision.gameSetupRevisionId]
    const equipmentSlots = setup?.slots.length ? setup.slots : SUGGESTED_BUILD_SLOTS
    const resolve = (ref: Parameters<typeof resolveEntity>[2]) => resolveEntity(localData, catalogs, ref)
    const report = validateBuildContent(revision.content, setup, equipmentSlots, resolve, ref => logicalEntityKey(localData, ref))
    const mainHandSlot = equipmentSlots.find(slot => equipmentRole(slot) === 'mainHand')
    const mainHand = mainHandSlot ? revision.content.equipment[mainHandSlot.id] : undefined
    const mainHandDefinition = mainHand ? resolve(mainHand.ref) : undefined
    const occupiesBothHands = mainHandDefinition && equipmentFacts(mainHandDefinition).twoHanded === true
    const loadoutFilled = Boolean(revision.content.primaryClass) && equipmentSlots.every(slot => revision.content.equipment[slot.id] || equipmentRole(slot) === 'offHand' && occupiesBothHands)
    return [{ revision, report, loadoutFilled, newer: newerTeamCheckpoint(localData, revision) }]
  })
  return {
    filled: members.length,
    loadoutsFilled: members.filter(member => member.loadoutFilled).length,
    valid: members.filter(member => member.report.status === 'valid').length,
    invalid: members.filter(member => member.report.status === 'invalid').length,
    unresolved: members.filter(member => member.report.status === 'undetermined').length,
    newer: members.filter(member => member.newer).length,
  }
}

export function TeamReview({ slots, localData, catalogs, saved = false }: { readonly slots: readonly (BuildRevisionId | null)[]; readonly localData: LocalData; readonly catalogs: readonly CatalogSnapshot[]; readonly saved?: boolean }) {
  const review = reviewTeam(slots, localData, catalogs)
  const complete = review.filled === TEAM_SIZE && review.loadoutsFilled === TEAM_SIZE
  return <section aria-label="Team review" className="team-review">
    <div className="cluster"><strong>{complete ? 'Team loadouts filled' : saved ? 'Saved draft Team' : 'Draft Team'}</strong><Badge tone={review.filled === TEAM_SIZE ? 'positive' : 'neutral'}>{review.filled}/{TEAM_SIZE} slots filled</Badge></div>
    <p>{review.loadoutsFilled}/{TEAM_SIZE} members have a class and equipment in every usable slot.</p>
    <p>{review.filled ? `${review.valid}/${review.filled} selected checkpoints have no known build issues.` : 'Choose a checkpoint to see build checks.'}{review.invalid > 0 && ` ${review.invalid} need changes.`}{review.unresolved > 0 && ` ${review.unresolved} have unresolved checks.`}</p>
    {review.newer > 0 && <p className="team-review__updates">{review.newer} {review.newer === 1 ? 'slot has a newer checkpoint' : 'slots have newer checkpoints'} available. Review before updating.</p>}
    {!complete && <small>Partial Teams can be saved and completed later. Empty equipment is separate from build validity.</small>}
  </section>
}
