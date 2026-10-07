import { compareBuildRevisions, entityDefinitionKey } from '../domain'
import type { BuildRevision, CatalogSnapshot, JsonValue, LocalData } from '../domain/types'
import { BuildLoadoutSummary } from './BuildLoadoutSummary'

export function TeamCheckpointComparison({ current, next, localData, catalogs }: { readonly current: BuildRevision; readonly next: BuildRevision; readonly localData: LocalData; readonly catalogs: readonly CatalogSnapshot[] }) {
  const names = new Map<string, string>()
  for (const definition of Object.values(localData.personalDefinitions)) names.set(entityDefinitionKey({ kind: 'personal', definitionId: definition.id }), definition.name)
  for (const catalog of catalogs) for (const entity of Object.values(catalog.entities)) names.set(entityDefinitionKey({ kind: 'catalog', catalogId: catalog.id, catalogRevisionId: catalog.revisionId, entityId: entity.id }), entity.name)
  const format = (value: JsonValue | undefined): string => {
    if (value == null) return 'None'
    if (typeof value === 'string') return names.get(value) ?? localData.gameSetups[value]?.label ?? value
    if (Array.isArray(value)) return value.map(format).join('; ') || 'None'
    if (typeof value === 'object') {
      if ('ref' in value && typeof value.ref === 'string') return `${format(value.ref)}${value.allocationId ? ' (shared copy)' : ''}`
      return Object.entries(value).map(([key, entry]) => `${key}: ${format(entry)}`).join('; ')
    }
    return String(value)
  }
  const differences = compareBuildRevisions(current, next).differences
  return <div className="stack team-checkpoint-comparison">
    <div className="team-checkpoint-comparison__loadouts">{[current, next].map((revision, index) => <section key={revision.id}><h3>{index === 0 ? 'Selected' : 'Newer'} checkpoint · r{revision.revision}</h3><p>{localData.gameSetups[revision.gameSetupRevisionId]?.label ?? 'Game Setup unavailable'}</p><BuildLoadoutSummary catalogs={catalogs} content={revision.content} equipmentNames gameSetup={localData.gameSetups[revision.gameSetupRevisionId]} localData={localData}/></section>)}</div>
    {differences.length ? <dl className="team-checkpoint-comparison__changes">{differences.map(difference => {
      const slotId = difference.path.startsWith('content.equipment.') ? difference.path.slice('content.equipment.'.length) : undefined
      const label = slotId ? localData.gameSetups[current.gameSetupRevisionId]?.slots.find(slot => slot.id === slotId)?.label ?? difference.label : difference.label
      return <div key={difference.path}><dt>{label}</dt><dd><span>Selected: {format(difference.left)}</span><span>Newer: {format(difference.right)}</span></dd></div>
    })}</dl> : <p>The loadout and calculation inputs are unchanged.</p>}
    {current.note !== next.note && <p>Checkpoint name: {current.note || 'None'} → {next.note || 'None'}</p>}
  </div>
}
