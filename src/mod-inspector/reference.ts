import { NATIVE_GAME_DATA } from '../catalog/native-game'
import schemaData from './reference-schema.json' with { type: 'json' }
import entityData from './entity-reference.json' with { type: 'json' }
import { childAt, childCount, nodeAtPath, objectProperty } from './document'
import { entityInteger, labelBaseEntity, labelModEntity, type BaseEntityRecord } from './entity-label'
import type { EditorVersionInfo, EnumCatalog, FieldAnnotation, InspectorIssue, InspectorRelationship, InspectorResolver, JsonNode, JsonPath, LookupOption, ParsedDocument } from './types'

type Parameter = { kind: 'enum' | 'reference' | 'scalar'; target?: string; allowed?: readonly string[] }
type Schema = { baselines: Record<string, { scope: string; source: { sha256: string }; records: readonly { ID: number; Name?: string }[] }>; references: Record<string, Record<string, { target: string; evidence: readonly string[] }>>; specialIdentifiers: Record<string, string>; variants: Record<string, { field: string; discriminator: string; models: Record<string, string> }>; enums: Record<string, Record<string, string>>; models: Record<string, Record<string, string>>; parameters: Record<string, { effects: Record<string, Record<string, Parameter>>; unused: readonly string[] }> }
const SCHEMA = schemaData as Schema
const ENUMS: Record<string, Record<string, string>> = Object.fromEntries([...new Set([...Object.keys(SCHEMA.enums), ...Object.keys(NATIVE_GAME_DATA.enums)])].map(name => [name, { ...SCHEMA.enums[name], ...NATIVE_GAME_DATA.enums[name] }]))
const SOURCE = 'Windows 1.6.9; Crystal Edit schema 34; other versions/platforms unverified'
export const INSPECTOR_SOURCE_LABEL = SOURCE
// Schema digest hashes compact JSON with recursively sorted keys, preserving array order
export const INSPECTOR_REFERENCE_ID = `windows-1.6.9:${NATIVE_GAME_DATA.contentDigest}:editor34:${schemaData.source.editorExecutableSha256}:schema:${schemaData.contentDigest}:entities:${entityData.contentDigest}`
const ENTITY_SOURCE = `${entityData.source.scope}; ${SOURCE}; field.dat SHA-256 ${entityData.source.world.sha256}; entity snapshot ${entityData.contentDigest}`
const BASE_ENTITIES = new Map((entityData.records as readonly BaseEntityRecord[]).map(record => [String(record.ID), record]))
const ENTITY_ID_EDIT_DETAIL = 'Choosing an ID retargets this entity only; other fields stay unchanged. No base definition is inserted or inherited.'
const MODEL_FAMILIES: Readonly<Record<string, string>> = Object.freeze({ ModelAbility: 'ability', ModelActor: 'actor', ModelEquipment: 'equipment', ModelFolder: 'folder', ModelItem: 'item', ModelJob: 'job', ModelMonster: 'monster', ModelPassive: 'passive', ModelSpark: 'spark', ModelStatus: 'status', ModelTroop: 'troop', ModelGender: 'gender', ModelDifficulty: 'difficulty', ModelBiome: 'biome', ModelAnimation: 'animation', ModelRecipe: 'recipe', ModelEntityData: 'entity', ModelVoxel: 'voxel', ModelPatch: 'patch' })
const REFERENCE_FIELDS: Readonly<Record<string, string>> = Object.freeze({ AbilityID: 'ModelAbility', AbilityIDs: 'ModelAbility', PassiveIDs: 'ModelPassive', StatusID: 'ModelStatus', InherentStatusID: 'ModelStatus', MonsterID: 'ModelMonster', AllyMonsterIDFilter: 'ModelMonster', ItemID: 'ModelItem', IncreaseMaxCapacityForItemID: 'ModelItem', EquipmentID: 'ModelEquipment', PvpWeaponID: 'ModelEquipment', PvpJobID: 'ModelJob', PvpGenderID: 'ModelGender', LocationBiomeID: 'ModelBiome', MapForBiomeID: 'ModelBiome', TroopID: 'ModelTroop', JobID: 'ModelJob' })
const EMPTY_OPTIONS: readonly LookupOption[] = []
const CATALOG: readonly EnumCatalog[] = Object.entries(ENUMS).sort(([a], [b]) => a.localeCompare(b)).map(([name, entries]) => ({ name, entries: Object.entries(entries).map(([value, label]) => ({ value, label, source: 'enum' as const, detail: `${name}; ${SOURCE}` })) }))
const ENUM_OPTIONS = new Map(CATALOG.map(entry => [entry.name, entry.entries]))

export function getEnumCatalog(): readonly EnumCatalog[] { return CATALOG }
function own<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record && Object.hasOwn(record, key) ? record[key] : undefined
}
const pathKey = (path: JsonPath) => JSON.stringify(path)
const within = (child: JsonPath, parent: JsonPath) => parent.length <= child.length && parent.every((part, index) => child[index] === part)
function code(node: JsonNode | undefined): string | undefined {
  if (node?.kind !== 'number' || !/^-?\d+$/.test(node.raw)) return undefined
  return BigInt(node.raw).toString()
}
function elementType(type: string): string {
  return type.endsWith('[]') ? type.slice(0, -2) : /^(?:List|ObservableCollection)<(.+)>$/.exec(type)?.[1] ?? type
}
interface Context { model: string; field: string; object: JsonNode; type?: string }
function propertyType(model: string, field: string, object: JsonNode): string | undefined {
  const variant = own(SCHEMA.variants, model)
  if (variant?.field === field) {
    const discriminatorType = own(own(SCHEMA.models, model), variant.discriminator)
    const value = code(objectProperty(object, variant.discriminator))
    const label = discriminatorType && value !== undefined ? own(own(ENUMS, discriminatorType), value) : undefined
    return label ? own(variant.models, label) : undefined
  }
  return own(own(SCHEMA.models, model), field)
}
function context(document: ParsedDocument, path: JsonPath): Context | undefined {
  let type = 'ModelMod'
  let node = document.root
  let result: Context | undefined
  for (const part of path) {
    if (typeof part === 'number') { type = elementType(type); if (result?.type) result = { ...result, type: elementType(result.type) }; node = childAt(node, part)! }
    else {
      result = { model: type, field: part, object: node, type: propertyType(type, part, node) }
      type = result.type ?? ''
      node = objectProperty(node, part)!
    }
    if (!node) return undefined
  }
  return result
}
function selector(ctx: Context): Parameter | undefined {
  const { model, field, object, type } = ctx
  if (model === 'ModelStatMod' || model === 'ModelAbilityMod' || model === 'ModelMonsterActionCondition') {
    const condition = model === 'ModelMonsterActionCondition'
    const tag = code(objectProperty(object, condition ? 'CondVar' : 'Tag'))
    const enumType = condition ? 'ActionConditionVar' : model === 'ModelStatMod' ? 'SangStatModTag' : 'SangAbilityModTag'
    const name = tag === undefined ? undefined : own(own(ENUMS, enumType), tag)
    if ((/^Value[123]$/.test(field) && !condition) || (condition && field === 'Data1')) {
      if (name && own(SCHEMA.parameters, model)?.unused.includes(name)) return { kind: 'scalar', target: 'unused' }
      return name ? own(own(own(SCHEMA.parameters, model)?.effects, name), field) ?? { kind: 'scalar' } : { kind: 'scalar' }
    }
  }
  if (model === 'ModelJobLearnNode' && field === 'DataID') {
    const nodeType = code(objectProperty(object, 'NodeType'))
    const target = nodeType === '2' ? 'ModelAbility' : nodeType === '3' ? 'ModelPassive' : undefined
    return target ? { kind: 'reference', target } : { kind: 'scalar', target: nodeType === '4' ? 'Growth node data: editor supplies 0; runtime meaning unverified' : 'Learn node data: no record selector for this node type' }
  }
  if (model === 'ModelSystemNode' && field === 'ID') {
    const scope = object.path.find(part => part === 'ItemPrerequisiteTree' || part === 'EquipmentPrerequisiteTree')
    return scope ? { kind: 'reference', target: scope === 'ItemPrerequisiteTree' ? 'ModelItem' : 'ModelEquipment' } : { kind: 'scalar', target: 'Prerequisite node identifier: target family unverified' }
  }
  if (model === 'ModelNode' && field === 'ModelID') {
    const id = code(objectProperty(object, 'ModelTypeID'))
    const target = id === undefined ? undefined : ENUMS.TreeModelType?.[id]
    return target && own(MODEL_FAMILIES, target) ? { kind: 'reference', target } : { kind: 'scalar' }
  }
  if (type && Object.hasOwn(ENUMS, type)) return { kind: 'enum', target: type }
  if (!type) return undefined
  const special = own(SCHEMA.specialIdentifiers, `${model}.${field}`)
  if (special) return { kind: 'scalar', target: special }
  const lootType = code(objectProperty(object, 'LootType'))
  if (model === 'ConditionDataAtlas' && field === 'LootValue') {
    const atlasType = code(objectProperty(object, 'Type'))
    const targets: Readonly<Record<string, string | undefined>> = { '0': lootType === '1' ? 'ModelItem' : lootType === '2' ? 'ModelEquipment' : undefined, '1': 'ModelMonster', '2': 'ModelBiome', '3': 'ModelJob' }
    const target = atlasType === undefined ? undefined : own(targets, atlasType)
    return target ? { kind: 'reference', target } : { kind: 'scalar', target: 'Atlas lookup value; target selector unverified' }
  }
  if (model === 'ModelEntityTreasure' && field === 'LootValue') return lootType === '1' ? { kind: 'reference', target: 'ModelItem' } : lootType === '2' ? { kind: 'reference', target: 'ModelEquipment' } : { kind: 'scalar', target: lootType === '0' || lootType === '3' ? 'Stored treasure currency amount or empty value' : 'Treasure loot value; loot type unknown' }
  if (field === 'LootID' && lootType) return lootType === '1' ? { kind: 'reference', target: 'ModelItem' } : lootType === '2' ? { kind: 'reference', target: 'ModelEquipment' } : undefined
  if (model === 'ModelItemDrop' && ((field === 'ItemID' && lootType !== '1') || (field === 'EquipmentID' && lootType !== '2'))) return undefined
  const target = own(own(SCHEMA.references, model), field)?.target ?? own(REFERENCE_FIELDS, field) ?? (field.endsWith('AnimationID') ? 'ModelAnimation' : undefined)
  return target ? { kind: 'reference', target } : undefined
}

const REFERENCING_MODELS = new Set(Object.entries(SCHEMA.models).filter(([model, fields]) => Object.keys(fields).some(field => Boolean(own(own(SCHEMA.references, model), field)) || Boolean(own(REFERENCE_FIELDS, field)) || field.endsWith('AnimationID')) || ['ModelStatMod', 'ModelAbilityMod', 'ModelMonsterActionCondition', 'ModelJobLearnNode', 'ModelNode', 'ModelSystemNode', 'ConditionDataAtlas', 'ModelEntityTreasure'].includes(model)).map(([model]) => model))
let referenceGraphChanged = true
while (referenceGraphChanged) {
  referenceGraphChanged = false
  for (const [model, fields] of Object.entries(SCHEMA.models)) {
    if (REFERENCING_MODELS.has(model)) continue
    const targets = [...Object.values(fields), ...Object.values(own(SCHEMA.variants, model)?.models ?? {})].map(type => {
      let element = type
      while (elementType(element) !== element) element = elementType(element)
      return element
    })
    if (targets.some(target => REFERENCING_MODELS.has(target))) { REFERENCING_MODELS.add(model); referenceGraphChanged = true }
  }
}

const CSHARP_INT_MIN = -2147483648n
const CSHARP_INT_MAX = 2147483647n
const EDITOR_REFERENCE_VERSION = schemaData.source.editorVersion
const IDENTIFIER_PREVIEW_LIMIT = 48
function identifierPreview(node: JsonNode | undefined): string {
  if (!node) return 'missing'
  if (node.kind === 'object' || node.kind === 'array') return node.kind
  return node.raw.length > IDENTIFIER_PREVIEW_LIMIT ? `${node.raw.slice(0, IDENTIFIER_PREVIEW_LIMIT)}... (${node.kind})` : node.raw
}
const VERSION_EDIT_DETAIL = 'CryKit keeps the imported original and does not apply format conversions. Changing this integer does not convert data and can suppress version migrations.'
function editorVersionInfo(document: ParsedDocument): EditorVersionInfo {
  const node = objectProperty(document.root, 'EditorVersion')
  const value = code(node)
  const common = { referenceVersion: EDITOR_REFERENCE_VERSION, value: node?.raw }
  if (!node) return { ...common, state: 'missing', label: 'EditorVersion missing', detail: `Crystal Edit and the pinned Windows loader default a missing marker to 0 and use legacy conversions. ${VERSION_EDIT_DETAIL}` }
  if (value === undefined || BigInt(value) < 0n || BigInt(value) > CSHARP_INT_MAX) return { ...common, state: 'invalid', label: 'Invalid EditorVersion', detail: `Expected a nonnegative C# int format marker. ${VERSION_EDIT_DETAIL}` }
  const version = BigInt(value)
  if (version > BigInt(EDITOR_REFERENCE_VERSION)) return { ...common, state: 'newer', label: `Newer editor format ${value}`, detail: `The pinned Windows 1.6.9 loader flags editor markers above ${EDITOR_REFERENCE_VERSION} as incompatible. Other game versions are unverified. ${VERSION_EDIT_DETAIL}` }
  if (version < BigInt(EDITOR_REFERENCE_VERSION)) return { ...common, state: 'older', label: `Older editor format ${value}`, detail: `The pinned Crystal Edit converts older data on open and writes format ${EDITOR_REFERENCE_VERSION} on save; the pinned Windows loader also applies version-dependent conversions. ${VERSION_EDIT_DETAIL}` }
  return { ...common, state: 'matched', label: `Crystal Edit format ${value}`, detail: `Matches the reference editor schema, not a guarantee of full mod compatibility. The game release is separately Windows 1.6.9. ${VERSION_EDIT_DETAIL}` }
}

export function createResolver(document: ParsedDocument): InspectorResolver {
  const issues: InspectorIssue[] = []
  const issueKeys = new Set<string>()
  const addIssue = (issue: InspectorIssue) => { const key = `${pathKey(issue.path)}:${issue.message}`; if (!issueKeys.has(key)) { issueKeys.add(key); issues.push(issue) } }
  const modIndex = new Map<string, Map<string, LookupOption[]>>()
  const baseIndex = new Map<string, Map<string, LookupOption>>()
  const optionsCache = new Map<string, readonly LookupOption[]>()
  const relatedLabel = (model: string, id: string): string | undefined => {
    ensureIndex(model)
    const local = modIndex.get(model)?.get(id)
    if (local && local.length > 1) return `Ambiguous ${own(MODEL_FAMILIES, model)} ID ${id}`
    return (local?.[0] ?? baseIndex.get(model)?.get(id))?.label
  }
  const ensureIndex = (model: string) => {
    if (modIndex.has(model)) return
    const family = own(MODEL_FAMILIES, model)
    if (!family) return
    const entries = new Map<string, LookupOption[]>()
    const collection = Object.entries(SCHEMA.models.ModelMod!).find(([, type]) => elementType(type) === model)?.[0]
    const collectionNode = collection ? objectProperty(document.root, collection) : undefined
    for (let index = 0; index < (collectionNode?.kind === 'array' ? childCount(collectionNode) : 0); index++) {
      const record = childAt(collectionNode!, index)!
      if (record.kind !== 'object') continue
      const id = model === 'ModelEntityData' ? entityInteger(objectProperty(record, 'ID')) : code(objectProperty(record, 'ID'))
      if (id === undefined) continue
      const name = objectProperty(record, 'Name')
      const entity = model === 'ModelEntityData' ? labelModEntity(record, relatedLabel) : undefined
      const label = entity?.label ?? (name?.kind === 'string' ? name.value as string : `${model} ${id}`)
      const replaced = entity && BASE_ENTITIES.get(id)
      const option: LookupOption = { value: id, label, source: 'mod', path: record.path, detail: entity ? `${entity.detail}; Mod-local entity ID ${id}${replaced ? `; replaces base ${labelBaseEntity(replaced, relatedLabel).label} without inheriting its fields` : ''}` : `Mod-local ${family}`, ...(entity ? { provenance: ENTITY_SOURCE } : {}) }
      const group = entries.get(id) ?? []; group.push(option); entries.set(id, group)
    }
    for (const [id, group] of entries) if (group.length > 1) for (const entry of group) addIssue({ path: [...entry.path!, 'ID'], severity: 'error', message: `Duplicate ${family} ID ${id}; references are ambiguous` })
    modIndex.set(model, entries)
    const bases = new Map<string, LookupOption>()
    if (model === 'ModelEntityData') for (const record of BASE_ENTITIES.values()) { const entity = labelBaseEntity(record, relatedLabel); bases.set(String(record.ID), { value: String(record.ID), label: entity.label, source: 'base', detail: `${entity.detail}; Base entity ID ${record.ID}`, provenance: ENTITY_SOURCE }) }
    const supplemental = own(SCHEMA.baselines, family)
    const records = supplemental?.records ?? NATIVE_GAME_DATA.databases[family]
    if (Array.isArray(records)) for (const record of records) {
      if (!record || typeof record !== 'object' || Array.isArray(record) || typeof record.ID !== 'number') continue
      bases.set(String(record.ID), { value: String(record.ID), label: typeof record.Name === 'string' ? record.Name : `${model} ${record.ID}`, source: 'base', detail: supplemental ? `${supplemental.scope}; SHA-256 ${supplemental.source.sha256}` : `Base ${family}; ${SOURCE}` })
    }
    baseIndex.set(model, bases)
  }
  for (const [model, family] of Object.entries(MODEL_FAMILIES)) {
    const collection = Object.entries(SCHEMA.models.ModelMod!).find(([, type]) => elementType(type) === model)?.[0]
    if (family !== 'entity' && collection && objectProperty(document.root, collection) && !own(SCHEMA.baselines, family) && !Array.isArray(NATIVE_GAME_DATA.databases[family])) addIssue({ path: [collection], severity: 'info', message: `Base ${family} records are not bundled; references outside this mod remain unknown` })
  }
  const editorVersion = editorVersionInfo(document)
  if (editorVersion.state !== 'matched') addIssue({ path: ['EditorVersion'], severity: 'warning', message: `${editorVersion.label}: ${editorVersion.detail}` })
  for (const key of ['GameVersion', 'Platform']) {
    const node = objectProperty(document.root, key)
    if (node && node.value !== (key === 'Platform' ? 'Windows' : '1.6.9')) addIssue({ path: [key], severity: 'warning', message: `${key} differs from the pinned Windows 1.6.9 lookup scope` })
  }
  const annotateNode = (node: JsonNode, ctx: Context): FieldAnnotation | undefined => {
    const path = node.path
    const value = code(node)
    if (ctx.model === 'ModelMod' && ctx.field === 'EditorVersion' && path.length === 1) return { kind: 'metadata', label: editorVersion.label, detail: editorVersion.detail, status: editorVersion.state === 'matched' ? 'resolved' : 'unknown' }
    if (ctx.model === 'ModelMod' && ctx.field === 'Tree' && path.length === 1 && node.kind === 'array') return { kind: 'metadata', label: 'Crystal Edit navigation', detail: 'Saved editor hierarchy, including references to unchanged baseline records; presence does not imply gameplay edits. Stored array order is preserved.', status: 'resolved' }
    if (ctx.type === 'ModelNode' && node.kind === 'object') {
      const typeID = code(objectProperty(node, 'ModelTypeID'))
      const modelType = typeID === undefined ? undefined : own(ENUMS.TreeModelType, typeID)
      const idNode = objectProperty(node, 'ModelID')
      const id = code(idNode)
      if (!modelType || !own(MODEL_FAMILIES, modelType) || id === undefined || BigInt(id) < CSHARP_INT_MIN || BigInt(id) > CSHARP_INT_MAX) return { kind: 'metadata', label: `Unknown navigation target (ModelTypeID ${identifierPreview(objectProperty(node, 'ModelTypeID'))}, ModelID ${identifierPreview(idNode)})`, detail: 'Navigation nodes reference model records; they do not store a Name.', status: 'unknown' }
      const target = annotateNode(idNode!, { model: 'ModelNode', field: 'ModelID', object: node, type: 'int' })!
      return { ...target, kind: 'metadata', label: `${target.label} (${modelType}, ModelID ${id})`, detail: `${target.detail ?? 'Target name is unresolved or ambiguous'}; Crystal Edit navigation reference; no Name is stored on the node` }
    }
    if (ctx.model === 'ModelNode' && ctx.field === 'Children' && node.kind === 'array') return { kind: 'metadata', label: 'Navigation children', detail: 'Saved child navigation nodes in stored array order; editor add/move operations sort siblings by SortOrder.', status: 'resolved' }
    if (ctx.model === 'ModelNode' && ctx.field === 'SortOrder') return { kind: 'metadata', label: 'Saved sibling sort order', detail: 'Crystal Edit sorts siblings by this value during add/move operations and renumbers them; CryKit preserves stored array order.', status: value !== undefined && BigInt(value) >= CSHARP_INT_MIN && BigInt(value) <= CSHARP_INT_MAX ? 'resolved' : 'unknown' }
    if (ctx.model === 'ModelNode' && ctx.field === 'IsExpanded') return { kind: 'metadata', label: 'Saved Crystal Edit expansion', detail: 'Saved expansion state in Crystal Edit; CryKit expansion is independent.', status: node.kind === 'boolean' ? 'resolved' : 'unknown' }
    if ((ctx.type === 'ModelEntityData' && node.kind === 'object') || (ctx.model === 'ModelEntityData' && ctx.field === 'ID')) {
      const record = ctx.field === 'ID' ? ctx.object : node
      const id = entityInteger(objectProperty(record, 'ID'))
      const entity = labelModEntity(record, relatedLabel)
      ensureIndex('ModelEntityData')
      const group = id === undefined ? undefined : modIndex.get('ModelEntityData')?.get(id)
      const option = group?.find(item => pathKey(item.path!) === pathKey(record.path))
      const status = group && group.length > 1 ? 'ambiguous' : id === undefined ? 'unknown' : entity.status
      return { kind: ctx.field === 'ID' ? 'identity' : 'metadata', label: `${entity.label}${ctx.field === 'ID' ? ` (entity ID ${id ?? 'unknown'})` : ''}`, status, detail: `${option?.detail ?? entity.detail}${ctx.field === 'ID' ? `; ${ENTITY_ID_EDIT_DETAIL}` : ''}`, provenance: ENTITY_SOURCE }
    }
    if (ctx.field === 'ID' && own(MODEL_FAMILIES, ctx.model) && value !== undefined) {
      ensureIndex(ctx.model)
      const group = modIndex.get(ctx.model)?.get(value)
      return { kind: 'identity', label: `${own(MODEL_FAMILIES, ctx.model)} ID ${value}`, status: group && group.length > 1 ? 'ambiguous' : 'resolved' }
    }
    if ((node.kind === 'array' || node.kind === 'object') && ctx.type && elementType(ctx.type) !== ctx.type) return undefined
    const spec = selector(ctx)
    if (!spec) return undefined
    if ((spec.kind === 'enum' || spec.kind === 'reference') && node.kind !== 'number' && node.kind !== 'null') {
      addIssue({ path, severity: 'warning', message: `Expected a numeric ${spec.kind} code; found ${node.kind}` })
      return { kind: spec.kind, label: `Invalid ${spec.kind} value type (${node.kind})`, status: 'unknown' }
    }
    if (spec.kind === 'scalar') return { kind: 'parameter', label: spec.target === 'unused' ? 'Unused by this effect' : spec.target ?? 'Scalar parameter; interpretation unknown', status: spec.target === 'unused' ? 'unused' : 'unknown', detail: 'Stored value is preserved; no quantity constraints are inferred' }
    if (node.kind === 'null') return { kind: spec.kind, label: 'Unspecified', status: 'unknown' }
    if (spec.kind === 'enum') {
      const label = value === undefined ? undefined : own(own(ENUMS, spec.target!), value)
      const restrictions = spec.allowed ? [`Crystal Edit selector permits codes ${spec.allowed.join(', ')}; runtime acceptance is unverified`] : undefined
      if (!label) addIssue({ path, severity: 'warning', message: `Unknown ${spec.target} code ${node.raw}` })
      else if (spec.allowed && !spec.allowed.includes(value!)) addIssue({ path, severity: 'warning', message: `${label} is outside the evidenced Crystal Edit selector filter` })
      return { kind: 'enum', label: label ?? `Unknown ${spec.target} (${node.raw})`, status: label ? 'resolved' : 'unknown', detail: `${spec.target === 'TreeModelType' ? 'ModelIntegration model registry (not a C# enum)' : spec.target}; ${SOURCE}`, restrictions }
    }
    ensureIndex(spec.target!)
    const local = value === undefined ? undefined : modIndex.get(spec.target!)?.get(value)
    const base = value === undefined ? undefined : baseIndex.get(spec.target!)?.get(value)
    const family = own(MODEL_FAMILIES, spec.target!) ?? spec.target
    if (local && local.length > 1) {
      addIssue({ path, severity: 'error', message: `Ambiguous ${family} ID ${value}: duplicate mod-local records` })
      return { kind: 'reference', label: `Ambiguous ${family} ID ${value}`, status: 'ambiguous', ...(family === 'entity' ? { provenance: ENTITY_SOURCE } : {}) }
    }
    const target = local?.[0] ?? base
    if (!target) addIssue({ path, severity: 'warning', message: `Unresolved ${family} ID ${node.raw}; absent from mod and bundled base reference` })
    return { kind: 'reference', label: target?.label ?? `Unknown ${family} ID ${node.raw}`, status: target ? 'resolved' : 'unknown', targetPath: target?.path, detail: target?.detail ?? (family === 'entity' ? 'Entity ID is absent from the mod and field world baseline' : !own(SCHEMA.baselines, family!) && !Array.isArray(NATIVE_GAME_DATA.databases[family!]) ? `Base ${family} records are not bundled; stored ID is preserved` : undefined), provenance: target?.provenance ?? (family === 'entity' ? ENTITY_SOURCE : undefined) }
  }
  const annotate = (path: JsonPath): FieldAnnotation | undefined => {
    const node = nodeAtPath(document.root, path)
    const ctx = context(document, path)
    return node && ctx ? annotateNode(node, ctx) : undefined
  }
  let edges: InspectorRelationship[] | undefined
  const inspectedEntityRecords = new Set<string>()
  const collectEdges = (selectedPath: JsonPath): InspectorRelationship[] => {
    const initialized = Boolean(edges)
    edges ??= []
    const visit = (node: JsonNode, type: string) => {
      if (node.kind === 'array') { for (const child of node.children) visit(child, elementType(type)); return }
      if (node.kind !== 'object' || !REFERENCING_MODELS.has(type)) return
      for (const child of node.children) {
        if (type === 'ModelMod' && child.key === 'Entities') continue
        const fieldType = propertyType(type, child.key!, node)
        if (!fieldType) continue
        if (child.kind === 'object' || child.kind === 'array') { visit(child, fieldType); if (child.kind === 'object' || selector({ model: type, field: child.key!, object: node, type: fieldType })?.kind !== 'reference') continue }
        if (selector({ model: type, field: child.key!, object: node, type: fieldType })?.kind !== 'reference') continue
        const values = child.kind === 'array' ? child.children : [child]
        for (const value of values) {
          const result = annotateNode(value, { model: type, field: child.key!, object: node, type: child.kind === 'array' ? elementType(fieldType) : fieldType })
          if (result?.kind === 'reference') edges!.push({ path: value.path, targetPath: result.targetPath, label: result.label, direction: 'outgoing', unresolved: result.status !== 'resolved' })
        }
      }
    }
    if (!initialized) {
      visit(document.root, 'ModelMod')
      if (objectProperty(document.root, 'Entities')) addIssue({ path: ['Entities'], severity: 'info', message: 'Incoming relationships cover database records, Tree, and inspected entity records; uninspected entity action records are excluded' })
    }
    if (selectedPath[0] === 'Entities' && typeof selectedPath[1] === 'number') {
      const recordPath = selectedPath.slice(0, 2)
      const key = pathKey(recordPath)
      if (!inspectedEntityRecords.has(key)) {
        inspectedEntityRecords.add(key)
        const record = nodeAtPath(document.root, recordPath)
        if (record) visit(record, 'ModelEntityData')
      }
    }
    return edges
  }
  return {
    editorVersion, sourceLabel: SOURCE, referenceId: INSPECTOR_REFERENCE_ID, issues, annotate,
    options(path) {
      const node = nodeAtPath(document.root, path)
      if (node?.kind !== 'number' && node?.kind !== 'null') return EMPTY_OPTIONS
      const ctx = context(document, path)
      if (!ctx) return EMPTY_OPTIONS
      const entityID = ctx.model === 'ModelEntityData' && ctx.field === 'ID'
      const spec: Parameter | undefined = entityID ? { kind: 'reference', target: 'ModelEntityData' } : selector(ctx)
      if (spec?.kind === 'enum') { const values = ENUM_OPTIONS.get(spec.target!) ?? EMPTY_OPTIONS; return spec.allowed ? values.filter(option => spec.allowed!.includes(option.value)) : values }
      if (spec?.kind !== 'reference') return EMPTY_OPTIONS
      ensureIndex(spec.target!)
      if (!optionsCache.has(spec.target!)) {
        const values = new Map(baseIndex.get(spec.target!))
        for (const [id, group] of modIndex.get(spec.target!) ?? []) values.set(id, group.length === 1 ? group[0]! : { value: id, label: `Ambiguous ID ${id}: ${group.map(entry => entry.label).join(', ')}`, source: 'mod', ...(spec.target === 'ModelEntityData' ? { detail: 'Duplicate mod-local entity records; ID is ambiguous', provenance: ENTITY_SOURCE } : {}) })
        optionsCache.set(spec.target!, [...values.values()])
      }
      return optionsCache.get(spec.target!)!
    },
    relationships(path) {
      return collectEdges(path).flatMap(edge => [
        ...(within(edge.path, path) ? [edge] : []),
        ...(edge.targetPath && within(edge.targetPath, path) ? [{ ...edge, direction: 'incoming' as const, targetPath: edge.path }] : []),
      ])
    },
  }
}
