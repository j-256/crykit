import { mapBuildModReferences, buildContentForModSetup } from '../domain/build-mods'
import { buildModReferences } from '../domain/build-references'
import { buildBehavior } from '../domain/build-behavior'
import { saveBuildRevision } from '../domain/builds'
import { saveSharedTeam } from '../domain/team-checkpoints'
import { publicSnapshotFromCheckpoint } from '../domain/public-source-context'
import { retainOutOfContextSelections } from '../domain/retained-selections'
import { definitionModAvailability } from '../catalog/mods'
import type { BuildRevisionId, TeamRevisionId, GameSetupRevisionId, BuildRevisionContent, EntityRef } from '../domain/types'
import type { WorkspaceState } from '../workspace/documents'
import { enrichPublicSnapshot } from './public-share-enrichment'
import { PublicNotesSchema, publicRefKey, type PublicNotes, type PublicRef } from './public-share-schema'

export type CopiedCheckpointRef = { readonly kind: 'build'; readonly revisionId: BuildRevisionId } | { readonly kind: 'team'; readonly revisionId: TeamRevisionId }
export interface CopiedCheckpointEdit {
  readonly checkpoint: CopiedCheckpointRef
  readonly notes?: PublicNotes
  readonly gameSetupRevisionId?: GameSetupRevisionId
}

// Adaptation creates a new ordinary checkpoint under an explicitly chosen local setup
// The public checkpoint and its unavailable receipts remain immutable historical evidence
export function editCopiedCheckpoint(before: WorkspaceState, input: CopiedCheckpointEdit) {
  const data = before.planner.localData
  const checkpoint = input.checkpoint.kind === 'build' ? data.buildRevisions[input.checkpoint.revisionId] : data.teamRevisions[input.checkpoint.revisionId]
  if (!checkpoint?.publicSourceContext) throw new Error('The copied checkpoint is unavailable. Reopen it before saving.')
  const sourceSetup = data.gameSetups[checkpoint.gameSetupRevisionId]!
  const title = 'slots' in checkpoint ? data.teams[checkpoint.teamId]!.title : data.builds[checkpoint.buildId]!.title
  const snapshot = publicSnapshotFromCheckpoint(sourceSetup, checkpoint, title)
  const notes = input.notes && PublicNotesSchema.parse(input.notes)
  if (notes && (notes.slots.length !== snapshot.slots.length || notes.slots.some((note, index) => Boolean(note) !== Boolean(snapshot.slots[index])) || !('slots' in checkpoint) && notes.checkpoint !== undefined)) throw new Error('Notes must match the copied checkpoint slots')
  const target = input.gameSetupRevisionId ? data.gameSetups[input.gameSetupRevisionId] : sourceSetup
  if (!target || input.gameSetupRevisionId && target.publicSourceContext) throw new Error('Choose an available local setup to adapt these selections')
  let rebind: ((ref: EntityRef | null) => EntityRef | null) | undefined
  if (input.gameSetupRevisionId) {
    const enrichment = enrichPublicSnapshot(snapshot, before)
    if (!enrichment.resolved || enrichment.adaptedProjections.length || snapshot.setup.baseline && enrichment.unresolvedCalculations) throw new Error('Exact matching definitions must be available before adapting this checkpoint')
    const refs = new Map(enrichment.entries.map(entry => [publicRefKey(entry.receipt.ref), entry.viewerRef!]))
    rebind = ref => {
      if (!ref) return ref
      const binding = ref.kind === 'personal' ? checkpoint.publicSourceContext!.personalBindings.find(value => value.ref.definitionId === ref.definitionId) : undefined
      const saved: PublicRef = ref.kind === 'catalog' ? { kind: 'catalog', catalogId: ref.catalogId, catalogRevisionId: ref.catalogRevisionId, entityId: ref.entityId } : { kind: 'personal', fingerprint: { kind: 'personal-definition-v1', value: binding?.fingerprint ?? '' } }
      const resolved = refs.get(publicRefKey(saved))
      if (!resolved) throw new Error('A selected definition has no exact matching local source')
      return resolved
    }
  }
  const content = (original: BuildRevisionContent, index: number): BuildRevisionContent => {
    const note = notes?.slots[index]
    const { rotationNotes: _rotation, ...withoutRotation } = original
    let next = note ? { ...withoutRotation, contextAssumptions: note.contextAssumptions, ...(note.rotationNotes !== undefined ? { rotationNotes: note.rotationNotes } : {}) } : original
    if (rebind) {
      next = buildContentForModSetup(mapBuildModReferences(next, rebind), target, before.planner.catalogs, buildBehavior(target))
      next = retainOutOfContextSelections(data, next, target, target.catalogLock)
      if (next.retainedSelections || buildModReferences(next).some(ref => { const availability = definitionModAvailability(data, ref, target, before.planner.catalogs); return availability.requiredMod && availability.state !== 'enabled' })) throw new Error('Choose a local setup that enables all selected definitions and equipment slots')
    }
    return next
  }
  let next
  let result: CopiedCheckpointRef
  if ('slots' in checkpoint) {
    const team = data.teams[checkpoint.teamId]
    if (team?.kind !== 'shared' || team.latestRevisionId !== checkpoint.id) throw new Error('The Team checkpoint changed. Reopen it before saving.')
    next = saveSharedTeam(data, { id: checkpoint.teamId, title, gameSetupRevisionId: target.id, slots: checkpoint.slots.map((slot, index) => slot ? { ...slot, content: content(slot.content, index), ...(notes?.slots[index]?.checkpoint !== undefined ? { note: notes.slots[index]!.checkpoint } : {}) } : null), note: notes ? notes.checkpoint : checkpoint.note, expectedRevision: data.revision })
    result = { kind: 'team', revisionId: (next.teams[checkpoint.teamId] as import('../domain/types').SharedTeam).latestRevisionId }
  } else {
    next = saveBuildRevision(data, { buildId: checkpoint.buildId, parentRevisionId: checkpoint.id, gameSetupRevisionId: target.id, content: content(checkpoint.content, 0), note: notes ? notes.slots[0]!.checkpoint : checkpoint.note, expectedRevision: data.revision })
    result = { kind: 'build', revisionId: next.builds[checkpoint.buildId]!.latestRevisionId! }
  }
  return { localData: next, checkpoint: result }
}
