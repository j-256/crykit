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
  const members = slots.flatMap((id, index) => {
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
    const emptyEquipment = equipmentSlots.filter(slot => !revision.content.equipment[slot.id] && !(equipmentRole(slot) === 'offHand' && occupiesBothHands)).map(slot => slot.label)
    return [{ index, revision, report, classSelected: Boolean(revision.content.primaryClass), emptyEquipment, label: `Slot ${index + 1}: ${localData.builds[revision.buildId]?.title ?? 'Build'}`, newer: newerTeamCheckpoint(localData, revision) }]
  })
  return {
    members,
    filled: members.length,
    classesSelected: members.filter(member => member.classSelected).length,
    emptyEquipment: members.filter(member => member.emptyEquipment.length > 0).map(member => ({ member: member.label, slots: member.emptyEquipment })),
    valid: members.filter(member => member.report.status === 'valid').length,
    invalid: members.filter(member => member.report.status === 'invalid').length,
    unresolved: members.filter(member => member.report.status === 'undetermined').length,
    newer: members.filter(member => member.newer).length,
  }
}

export function TeamReview({ slots, localData, catalogs, saved = false }: { readonly slots: readonly (BuildRevisionId | null)[]; readonly localData: LocalData; readonly catalogs: readonly CatalogSnapshot[]; readonly saved?: boolean }) {
  const review = reviewTeam(slots, localData, catalogs)
  const complete = review.filled === TEAM_SIZE
  return <section aria-label="Team review" className="team-review">
    <div className="cluster"><strong>{complete ? saved ? 'Saved Team' : 'Team members selected' : saved ? 'Saved draft Team' : 'Draft Team'}</strong><Badge tone={complete ? 'positive' : 'neutral'}>{review.filled}/{TEAM_SIZE} slots filled</Badge></div>
    {review.filled > 0 && <p>{review.classesSelected}/{review.filled} selected members have a class. Equipment slots may be intentionally empty.</p>}
    <p>{review.filled ? `${review.valid}/${review.filled} selected checkpoints have no known build issues.` : 'Choose a checkpoint to see build checks.'}{review.invalid > 0 && ` ${review.invalid} need changes.`}{review.unresolved > 0 && ` ${review.unresolved} have unresolved checks.`}</p>
    {review.newer > 0 && <p className="team-review__updates">{review.newer} {review.newer === 1 ? 'slot has a newer checkpoint' : 'slots have newer checkpoints'} available. Review before updating.</p>}
    {review.emptyEquipment.length > 0 && <details><summary>Review empty equipment slots</summary><ul>{review.emptyEquipment.map(member => <li key={member.member}>{member.member}: {member.slots.join(', ')}</li>)}</ul><p>Empty slots do not prevent saving a Team or mean its members are incompatible.</p></details>}
    {!complete && <small>Partial Teams can be saved and completed later. Choose a checkpoint for each remaining member slot.</small>}
  </section>
}
