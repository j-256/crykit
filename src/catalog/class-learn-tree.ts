import identities from './class-tree-identities.json' with { type: 'json' }
import vanilla from './vanilla-jobs.json' with { type: 'json' }
import { classFields, CRYSTAL_EDIT_FIELDS, exportedTree, jsonRecord, LEARN_NODE_TYPES, type ExportedTreeNode } from '../domain/crystal-edit'
import { modModelEntity } from '../domain/mod-layers'
import { bundledModEntityId, bundledModIdentity, bundledModRecord } from '../domain/bundled-mods'
import { nativeIdentity, nativeRelationships, nativeSourceRecord } from '../domain/native-game'
import { baseGameEntityId, catalogEntity } from '../domain/entity-identities'
import type { CatalogEntity, CatalogSnapshot, PersonalDefinition, SourceRef } from '../domain/types'

export const CLASS_TREE_IDENTITY_SOURCE: SourceRef = identities.source
export const JP_PER_LP = identities.learningCostDisplay.jpPerLp

export interface ClassTreeSkill {
  readonly name: string
  readonly kind: CatalogEntity['kind']
  readonly definition?: CatalogEntity
  readonly jp?: number
  readonly monsterLearned: boolean
}

const orderedTree = (tree: readonly ExportedTreeNode[]) => JSON.stringify([...tree].sort((a, b) => a.row - b.row || a.column - b.column))
const baselineTrees = vanilla.jobs.map(job => ({ copiedJobId: job.ID, tree: orderedTree(exportedTree({ fields: classFields(job, vanilla.source) })), identity: identities.classes[`base:class:${job.Name.toLowerCase()}` as keyof typeof identities.classes] }))

export function bundledTreeIdentity(entity: CatalogEntity | PersonalDefinition) {
  const field = entity.fields[CRYSTAL_EDIT_FIELDS.tree]
  const copiedId = entity.fields['Crystal Edit copied job ID']
  if (field?.state !== 'known' || !field.sources?.some(source => source.sourceId === vanilla.source.sourceId) || copiedId?.state !== 'known') return undefined
  return baselineTrees.find(entry => entry.copiedJobId === copiedId.value && entry.tree === orderedTree(exportedTree(entity)))?.identity
}

export function classTreeSkill(entity: CatalogEntity | PersonalDefinition, node: ExportedTreeNode, catalog?: CatalogSnapshot, sourceEntity?: CatalogEntity): ClassTreeSkill {
  const family = node.nodeType === LEARN_NODE_TYPES.ability ? 'Abilities' : node.nodeType === LEARN_NODE_TYPES.passive ? 'Passives' : undefined
  const identityEntity = nativeIdentity(entity) ? entity as CatalogEntity : sourceEntity
  const native = identityEntity && nativeIdentity(identityEntity)
  const mod = bundledModIdentity(entity as CatalogEntity) ?? (sourceEntity && bundledModIdentity(sourceEntity))
  const link = native && catalog && identityEntity ? nativeRelationships(catalog, { ...identityEntity, fields: entity.fields }).find(link => link.label === `/LearnTree/${node.column}/${node.row}/DataID` && link.databaseId === node.dataId && link.database === (family === 'Abilities' ? 'ability' : 'passive')) : undefined
  let imported: CatalogEntity | undefined
  if (catalog && family) imported = mod ? catalog.entities[bundledModEntityId(mod.key, family, node.dataId)] : native ? link?.targetId ? catalog.entities[link.targetId] : undefined : modModelEntity(catalog, `crystal-edit:${family}:${node.dataId}`)
  if (imported && (family === 'Abilities' ? imported.kind === 'ability' || imported.kind === 'monsterMagic' : imported.kind === 'passive' || imported.kind === 'innate')) {
    const field = imported.fields['Crystal Edit source record']
    const record = mod ? bundledModRecord(imported) : native ? nativeSourceRecord(imported) : field?.state === 'known' && jsonRecord(field.value) ? field.value : undefined
    const jp = record?.JP
    const monsterLearned = record?.IsSightLearned === true
    return { name: imported.name, kind: monsterLearned && imported.kind === 'ability' ? 'monsterMagic' : imported.kind, definition: imported, jp: typeof jp === 'number' && Number.isInteger(jp) && jp >= 0 ? jp : undefined, monsterLearned }
  }
  const identity = bundledTreeIdentity(entity)?.nodes.find(entry => entry.row === node.row && entry.column === node.column && entry.nodeType === node.nodeType && entry.dataId === node.dataId)
  if (identity) {
    const candidate = catalog && catalogEntity(catalog, baseGameEntityId(identity.nodeType === LEARN_NODE_TYPES.ability ? 'ability' : 'passive', identity.dataId))
    const definition = candidate?.kind === identity.kind ? candidate : undefined
    return { name: definition?.name ?? identity.name, kind: identity.kind as CatalogEntity['kind'], definition, jp: identity.jp, monsterLearned: identity.kind === 'monsterMagic' }
  }
  return { name: family ? `${family === 'Abilities' ? 'Ability' : 'Passive'} #${node.dataId}` : `Unknown node type ${node.nodeType}`, kind: family === 'Abilities' ? 'ability' : family === 'Passives' ? 'passive' : 'other', monsterLearned: false }
}
