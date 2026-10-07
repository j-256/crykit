import { useMemo } from 'react'
import { nativeDescription } from '../catalog/native-description'
import { corroboratedFact } from '../catalog/source-corroboration'
import { calculationModResolver } from '../domain/calculation-mods'
import { CLASS_FIELDS, CRYSTAL_EDIT_FIELDS } from '../domain/crystal-edit'
import { crystalEditPlanningRecord } from '../domain/crystal-edit-compatibility'
import { entityDefinitionKey } from '../domain/core'
import { resolveGameRules } from '../domain/game-rules'
import { nativeDisplayDescription, nativeDisplayName, nativeIdentity, nativeSourceRecord } from '../domain/native-game'
import type { CatalogSnapshot, GameSetupRevision, LocalData } from '../domain/types'
import { AbilityPreview, AbilityPreviewGroup } from './AbilityPreview'
import { compactKnowledge, selectionSummaryLines } from './build-evidence'
import type { DefinitionOption } from './definitions'
import { DefinitionArtwork } from './GameIcon'
import { SourceReferences } from './KnowledgeValue'
import { resolveCalculationEntity, resolveEntity } from './model'
import { nativeTarget, previewAbilityGroups } from './preview-ability-groups'
import { Sources } from './Sources'

const COST_RESOURCES = ['HP', 'MP', 'AP', 'CT', 'CD'] as const

function abilityCost(definition: DefinitionOption['record']): string {
  const field = definition.fields.Cost
  if (field) return field.state === 'known' && typeof field.value === 'string' ? field.value === 'None' ? 'No cost' : field.value.split(/\r?\n/).join(', ') : `Cost: ${compactKnowledge(field)}`
  const record = crystalEditPlanningRecord(definition) ?? nativeSourceRecord(definition)
  if (!record || COST_RESOURCES.some(resource => typeof record[`${resource}Cost`] !== 'number')) return 'Cost unknown'
  return COST_RESOURCES.filter(resource => record[`${resource}Cost`] !== 0).map(resource => `${record[`${resource}Cost`]}${resource === 'HP' ? '%' : ''} ${resource}`).join(', ') || 'No cost'
}

export function CommandAbilities({ option, command, localData, catalogs, gameSetup }: { readonly option: DefinitionOption; readonly command: string; readonly localData: LocalData; readonly catalogs: readonly CatalogSnapshot[]; readonly gameSetup?: GameSetupRevision }) {
  const abilities = useMemo(() => {
    // Command membership is independent of a character's learned skills and never comes from names or tree positions
    const groups = previewAbilityGroups({ primaryClass: option.ref, secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [] }, localData, catalogs, gameSetup)
    const resolve = calculationModResolver(ref => resolveCalculationEntity(localData, catalogs, ref, gameSetup)).resolve
    const mode = resolveGameRules(gameSetup, catalogs).mode ?? 'standard'
    return (groups[0]?.refs ?? []).flatMap(ref => {
      const selected = resolve(ref)
      if (!selected) return []
      const identity = nativeIdentity(selected)
      const catalog = ref.kind === 'catalog' ? catalogs.find(catalog => catalog.id === ref.catalogId && catalog.revisionId === ref.catalogRevisionId) : undefined
      // Mode variants supply their own costs and text; an imported replacement must keep its exact record
      const variant = catalog && identity?.database === 'ability' && identity.mode === 'base' && mode !== 'standard' && !selected.fields['Crystal Edit source record'] ? nativeTarget(catalog, 'ability', identity.databaseId, mode) : undefined
      // Availability metadata is not part of native description identity; keep the exact source definition
      const definition = variant ?? resolveEntity(localData, catalogs, ref)!
      const name = nativeDisplayName(definition)
      const details = { ...option, ref, kind: definition.kind, name, description: undefined, record: definition }
      const native = nativeDescription(definition)
      // Native effect text omits scaling formulas; retain authored descriptions for those gaps with their evidence
      const useDescription = !native || native.unresolved.includes('Ability power formula') || native.unresolved.includes('Weapon type scope details')
      const descriptionField = useDescription ? definition.fields.Description : undefined
      const description = useDescription ? descriptionField ? compactKnowledge(descriptionField) : nativeDisplayDescription(definition) : undefined
      const lines = [...new Set([...(description?.split(/\r?\n/).filter(Boolean) ?? []), ...selectionSummaryLines(details).filter(line => !/^cost:/i.test(line))])]
      const target = catalog && !definition.fields['Crystal Edit source record'] && 'legacy' in definition ? { catalog, entity: definition } : undefined
      const shownFields = { Cost: definition.fields.Cost, Description: descriptionField }
      const sources = [...Object.entries(shownFields).flatMap(([field, value]) => {
        if (!value || value.state === 'notApplicable' || corroboratedFact(target, field, value)) return []
        return value.state === 'conflicting' ? value.claims.flatMap(claim => claim.sources) : value.sources ?? []
      }), ...(!native || description && !descriptionField ? definition.sources : [])]
      return [{ ref, name, cost: abilityCost(definition), lines, sources }]
    })
  }, [option, localData, catalogs, gameSetup])
  const membership = option.record.fields[CLASS_FIELDS.abilities] ?? option.record.fields[CRYSTAL_EDIT_FIELDS.abilities]
  const knownEmpty = membership?.state === 'known' && Array.isArray(membership.value) && membership.value.length === 0
  return <section aria-label={`${command} abilities`} className="command-abilities">
    <div className="command-abilities__heading"><div className="cluster"><h4>{command}</h4>{abilities.some(ability => ability.sources.length) && <Sources label={`Sources for ${command} abilities`}>{abilities.filter(ability => ability.sources.length).map(ability => <div key={entityDefinitionKey(ability.ref)}><strong>{ability.name}</strong><SourceReferences includeGameExports sources={ability.sources}/></div>)}</Sources>}</div>{abilities.length > 0 && <small>Base cost</small>}</div>
    {abilities.length ? <AbilityPreviewGroup key={option.key}><ul aria-label={`${command} ability list`}>{abilities.map(ability => <li key={entityDefinitionKey(ability.ref)}><AbilityPreview cost={ability.cost} icon={<DefinitionArtwork catalogs={catalogs} localData={localData} value={ability.ref}/>} lines={ability.lines} name={ability.name}/></li>)}</ul></AbilityPreviewGroup> : <p className="field__hint">{knownEmpty ? 'No command abilities.' : 'Ability list unavailable.'}</p>}
  </section>
}
