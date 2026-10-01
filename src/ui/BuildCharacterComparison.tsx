import { sameBuildBehavior } from '../domain/build-behavior'
import type { BuildRevision, CatalogSnapshot, Character, EntityRef, Knowledge, LocalData } from '../domain/types'
import { entityName, knowledgeLabel } from './model'

export function BuildCharacterComparison({ localData, catalogs, revision, character }: { localData: LocalData; catalogs: readonly CatalogSnapshot[]; revision: BuildRevision; character: Character }) {
  const snapshot = character.currentSnapshotId ? character.snapshots[character.currentSnapshotId] : undefined
  const setup = localData.gameSetups[revision.gameSetupRevisionId]
  const recordedSetup = snapshot?.gameSetupRevisionId ? localData.gameSetups[snapshot.gameSetupRevisionId] : undefined
  const name = (ref: EntityRef | null | undefined) => ref ? entityName(localData, catalogs, ref) : 'Empty'
  const observed = (value: Knowledge<EntityRef> | undefined) => value ? value.state === 'known' ? name(value.value) : value.state === 'notApplicable' ? 'Empty' : knowledgeLabel(value) : 'Unrecorded'
  const ids = [...new Set([...(setup?.slots.map(slot => slot.id) ?? []), ...Object.keys(snapshot?.equipment ?? {}), ...Object.keys(revision.content.equipment)])]
  const rows = [
    { label: 'Class', before: observed(snapshot?.primaryClass), after: name(revision.content.primaryClass) },
    { label: 'Sub-command', before: observed(snapshot?.secondaryClass), after: name(revision.content.secondaryClass) },
    ...ids.map(id => ({ label: setup?.slots.find(slot => slot.id === id)?.label ?? recordedSetup?.slots.find(slot => slot.id === id)?.label ?? id, before: snapshot && Object.hasOwn(snapshot.equipment, id) ? name(snapshot.equipment[id]) : 'Unrecorded', after: name(revision.content.equipment[id]?.ref) })),
    { label: 'Passives', before: snapshot?.passives.state === 'known' ? snapshot.passives.value.map(name).join(', ') || 'None' : snapshot ? knowledgeLabel(snapshot.passives) : 'Unrecorded', after: revision.content.passives.map(selection => name(selection.ref)).join(', ') || 'None' },
  ]
  return <section aria-label={`Compare ${character.name} with build`} className="stack">
    <p>{character.name}: recorded loadout compared with {localData.builds[revision.buildId]?.title ?? 'Build'} r{revision.revision}.</p>
    {snapshot && !sameBuildBehavior(recordedSetup, setup) && <p className="field__hint">The recorded and planned Game Setup differ. Slots are compared by their saved identities.</p>}
    <div className="structured-value__table"><table><thead><tr><th>Selection</th><th>Recorded now</th><th>Proposed build</th></tr></thead><tbody>{rows.map((row, index) => <tr key={index}><th scope="row">{row.label}</th><td>{row.before}</td><td>{row.after}</td></tr>)}</tbody></table></div>
  </section>
}
