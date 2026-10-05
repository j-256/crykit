import type { CatalogEntityKind, CatalogSnapshot, EntityRef, JsonValue, Knowledge, LocalData, LocalDataId, Timestamp } from '../domain/types'
import { entityDefinitionKey } from '../domain/core'
import { battleCalculationReferences } from '../domain/battle-plan'
import { assertModConfiguration } from '../domain/mods'
import { composeModCatalog, expandModCatalogs, modCatalogForPin, modCatalogRevision } from '../domain/mod-layers'
import { TEAM_SIZE } from '../domain/scenarios'
import { assertSkillTreeGeometry, skillTreeShape, squareKey } from '../domain/skill-trees'
import {
  definitionLineageRootRef,
  logicalEntityKey,
} from '../domain/definitions'
import { AppDataError } from './errors'
import { isJsonObject, NATIVE_BACKUP_JSON_LIMITS, parseBoundedJson } from './json'
import {
  NativeCatalogSnapshotSchema,
  NativeHistorySchema,
  NativeManifestSchema,
  NativePayloadSchema,
  NativeLocalDataSchema,
} from './native-schema'
import { catalogSnapshotKey } from './identity'
import type {
  EvidenceRecord,
  ImportPreview,
  NativeBackupManifest,
  PersistedHistoryEntry,
  LocalDataLineage,
  SourceArchiveRecord,
} from './types'
import { asLocalDataId, nowTimestamp, randomId, sha256 } from './util'
import { NATIVE_BACKUP_ARCHIVE_LIMITS, safeUnzip } from './zip'

const MAX_NATIVE_HISTORY = 500
const validatedImmutableCatalogs = new WeakSet<CatalogSnapshot>()
const frozenCatalogValues = new WeakSet<object>()

function freezeCatalogValue(value: unknown): void {
  if (!value || typeof value !== 'object' || frozenCatalogValues.has(value)) return
  frozenCatalogValues.add(value)
  for (const child of Object.values(value)) freezeCatalogValue(child)
  Object.freeze(value)
}

export function immutableCatalogSnapshot(catalog: CatalogSnapshot): CatalogSnapshot {
  if (validatedImmutableCatalogs.has(catalog)) return catalog
  if (!NativeCatalogSnapshotSchema.safeParse(catalog).success) schemaError('A transformed catalog has an unsupported shape')
  freezeCatalogValue(catalog)
  validatedImmutableCatalogs.add(catalog)
  return catalog
}

function schemaError(message: string, details?: Readonly<Record<string, unknown>>): never {
  throw new AppDataError('schema-mismatch', message, { recoverable: true, details })
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) schemaError(`${label} must be an object`)
  return value as Record<string, unknown>
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) schemaError(`${label} must be a nonempty string`)
  return value
}

function revisionValue(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) schemaError(`${label} must be a nonnegative integer`)
  return value as number
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.entries(value as Readonly<Record<string, unknown>>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function assertIdMap(value: unknown, label: string): Record<string, Record<string, unknown>> {
  const record = recordValue(value, label)
  const result: Record<string, Record<string, unknown>> = Object.create(null) as Record<string, Record<string, unknown>>
  for (const [key, entry] of Object.entries(record)) {
    const object = recordValue(entry, `${label}.${key}`)
    if (stringValue(object.id, `${label}.${key}.id`) !== key) {
      schemaError(`${label} has a key/ID mismatch`, { key, id: object.id })
    }
    result[key] = object
  }
  return result
}

interface ValidatedCatalogs {
  readonly snapshots: readonly CatalogSnapshot[]
  readonly keys: ReadonlyMap<string, ReadonlySet<string>>
  readonly entityKinds: ReadonlyMap<string, CatalogEntityKind>
}

function knowledgeValues<Value>(knowledge: Knowledge<Value> | undefined): readonly Value[] {
  if (!knowledge) return []
  if (knowledge.state === 'known') return [knowledge.value]
  if (knowledge.state === 'conflicting') return knowledge.claims.map((claim) => claim.value)
  return []
}

function validateEntityRef(
  ref: EntityRef,
  catalogs: ReadonlyMap<string, ReadonlySet<string>>,
  personalDefinitionIds: ReadonlySet<string>,
  path: string,
): void {
  if (ref.kind === 'catalog') {
    const entities = catalogs.get(catalogSnapshotKey(ref.catalogId, ref.catalogRevisionId))
    if (!entities?.has(ref.entityId)) schemaError('A reference points to a missing catalog entity', { path })
    return
  }
  if (!personalDefinitionIds.has(ref.definitionId)) {
    schemaError('A reference points to a missing personal definition', { path })
  }
}

function validateDefinitionRequirements(
  requirements: CatalogSnapshot['entities'][string]['requirements'],
  catalogs: ReadonlyMap<string, ReadonlySet<string>>,
  personalDefinitionIds: ReadonlySet<string>,
  path: string,
): void {
  for (const values of knowledgeValues(requirements)) {
    for (const [index, requirement] of values.entries()) {
      if (requirement.kind === 'selected') {
        validateEntityRef(requirement.ref, catalogs, personalDefinitionIds, `${path}[${index}].ref`)
      }
    }
  }
}

function validateCatalogs(values: readonly unknown[]): ValidatedCatalogs {
  const snapshots: CatalogSnapshot[] = []
  const keys = new Map<string, ReadonlySet<string>>()
  const entityKinds = new Map<string, CatalogEntityKind>()
  for (const [index, value] of expandModCatalogs(values as readonly CatalogSnapshot[]).entries()) {
    const record = recordValue(value, `catalogs[${index}]`)
    const id = stringValue(record.id, `catalogs[${index}].id`)
    const revisionId = stringValue(record.revisionId, `catalogs[${index}].revisionId`)
    stringValue(record.schemaVersion, `catalogs[${index}].schemaVersion`)
    stringValue(record.checksum, `catalogs[${index}].checksum`)
    const entities = assertIdMap(record.entities, `catalogs[${index}].entities`)
    if (!Array.isArray(record.claims)) schemaError(`catalogs[${index}].claims must be an array`)
    for (const [claimIndex, claimValue] of record.claims.entries()) {
      const claim = recordValue(claimValue, `catalogs[${index}].claims[${claimIndex}]`)
      const entityId = stringValue(claim.entityId, `catalogs[${index}].claims[${claimIndex}].entityId`)
      if (!entities[entityId]) schemaError('A catalog claim references an unknown entity', { id, revisionId, entityId })
    }
    const key = catalogSnapshotKey(id, revisionId)
    if (keys.has(key)) schemaError('The backup contains a duplicate catalog revision', { id, revisionId })
    keys.set(key, new Set(Object.keys(entities)))
    snapshots.push(value as CatalogSnapshot)
    for (const entity of Object.values((value as CatalogSnapshot).entities)) {
      entityKinds.set(entityDefinitionKey({
        kind: 'catalog',
        catalogId: (value as CatalogSnapshot).id,
        catalogRevisionId: (value as CatalogSnapshot).revisionId,
        entityId: entity.id,
      }), entity.kind)
    }
  }
  for (const [index, snapshot] of snapshots.entries()) {
    for (const [entityId, entity] of Object.entries(snapshot.entities)) {
      validateDefinitionRequirements(entity.requirements, keys, new Set(), `catalogs[${index}].entities.${entityId}.requirements`)
    }
  }
  return { snapshots, keys, entityKinds }
}

function validatePinnedReferences(
  localData: LocalData,
  value: unknown,
  lock: Readonly<Record<string, unknown>>,
  label: string,
): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validatePinnedReferences(localData, entry, lock, `${label}[${index}]`))
    return
  }
  const record = value as Readonly<Record<string, unknown>>
  if (record.kind === 'catalog') {
    const catalogId = stringValue(record.catalogId, `${label}.catalogId`)
    const revisionId = stringValue(record.catalogRevisionId, `${label}.catalogRevisionId`)
    if (lock[catalogId] !== revisionId) {
      schemaError('A build content reference falls outside its pinned catalog lock', { label, catalogId, revisionId })
    }
    return
  }
  if (record.kind === 'personal' && typeof record.definitionId === 'string') {
    const rootRef = definitionLineageRootRef(localData, record as unknown as EntityRef)
    if (rootRef.kind === 'catalog' && lock[rootRef.catalogId] !== rootRef.catalogRevisionId) {
      schemaError('A personal override base falls outside its pinned catalog lock', {
        label,
        catalogId: rootRef.catalogId,
        revisionId: rootRef.catalogRevisionId,
      })
    }
    return
  }
  for (const [key, nested] of Object.entries(record)) validatePinnedReferences(localData, nested, lock, `${label}.${key}`)
}

function validatePersonalDefinitionLineage(
  localData: LocalData,
  catalogEntityKinds: ReadonlyMap<string, CatalogEntityKind>,
): void {
  const successors = new Set<string>()
  const initialOverrides = new Set<string>()
  for (const [id, definition] of Object.entries(localData.personalDefinitions)) {
    const selfRef: EntityRef = { kind: 'personal', definitionId: definition.id }
    if (definition.baseRef && entityDefinitionKey(definition.baseRef) === entityDefinitionKey(selfRef)) {
      schemaError('A personal definition cannot use itself as its lineage base', { id })
    }
    if (definition.previousRevision && !definition.baseRef) {
      schemaError('A personal definition revision is missing its lineage base', { id })
    }
    if (!definition.previousRevision) {
      if (definition.baseRef?.kind === 'personal') {
        schemaError('A personal-base override must identify its predecessor', { id })
      }
      if (definition.baseRef && definition.revision !== 1) {
        schemaError('An initial personal override must start at revision 1', { id })
      }
      if (definition.baseRef?.kind === 'catalog') {
        const baseKind = catalogEntityKinds.get(entityDefinitionKey(definition.baseRef))
        if (baseKind !== undefined && baseKind !== definition.kind) {
          schemaError('A personal override changes its catalog base kind', { id })
        }
      }
      if (definition.baseRef) {
        const rootKey = entityDefinitionKey(definition.baseRef)
        if (initialOverrides.has(rootKey)) schemaError('A personal definition lineage has multiple initial overrides', { id })
        initialOverrides.add(rootKey)
      }
      continue
    }
    const previous = localData.personalDefinitions[definition.previousRevision.definitionId]
    if (!previous) schemaError('A personal definition revision points to a missing predecessor', { id })
    if (successors.has(previous.id)) schemaError('A personal definition revision has multiple successors', { id })
    successors.add(previous.id)
    if (definition.revision !== previous.revision + 1) {
      schemaError('A personal definition revision is not consecutive', { id })
    }
    if (definition.kind !== previous.kind) {
      schemaError('A personal definition revision changes its entity kind', { id })
    }
    const expectedBase = definitionLineageRootRef(localData, definition.previousRevision)
    if (!definition.baseRef || entityDefinitionKey(definition.baseRef) !== entityDefinitionKey(expectedBase)) {
      schemaError('A personal definition revision changes its lineage base', { id })
    }
  }
  for (const [id, definition] of Object.entries(localData.personalDefinitions)) {
    const visited = new Set<string>([id])
    let previous = definition.previousRevision
    while (previous) {
      if (visited.has(previous.definitionId)) schemaError('Personal definition lineage contains a cycle', { id })
      visited.add(previous.definitionId)
      previous = localData.personalDefinitions[previous.definitionId]?.previousRevision
    }
  }
}

function validateLocalDataEntityRefs(
  localData: LocalData,
  catalogs: ReadonlyMap<string, ReadonlySet<string>>,
  personalDefinitionIds: ReadonlySet<string>,
  label: string,
): void {
  const check = (ref: EntityRef, path: string): void => validateEntityRef(ref, catalogs, personalDefinitionIds, path)
  for (const [id, definition] of Object.entries(localData.personalDefinitions)) {
    if (definition.baseRef) check(definition.baseRef, `${label}.personalDefinitions.${id}.baseRef`)
    if (definition.previousRevision) check(definition.previousRevision, `${label}.personalDefinitions.${id}.previousRevision`)
    validateDefinitionRequirements(definition.requirements, catalogs, personalDefinitionIds, `${label}.personalDefinitions.${id}.requirements`)
  }
  for (const [id, gameSetup] of Object.entries(localData.gameSetups)) {
    for (const [index, ref] of (gameSetup.definitionOverrides ?? []).entries()) {
      check(ref, `${label}.gameSetups.${id}.definitionOverrides[${index}]`)
    }
  }
  for (const layout of Object.values(localData.skillTreeLayouts ?? {})) {
    check(layout.classRef, `${label}.skillTreeLayouts.${layout.id}.classRef`)
    for (const mapping of layout.mappings) check(mapping.ref, `${label}.skillTreeLayouts.${layout.id}.mappings`)
  }
  for (const [id, revision] of Object.entries(localData.buildRevisions)) {
    if (revision.content.primaryClass) check(revision.content.primaryClass, `${label}.buildRevisions.${id}.content.primaryClass`)
    if (revision.content.secondaryClass) check(revision.content.secondaryClass, `${label}.buildRevisions.${id}.content.secondaryClass`)
    for (const [index, row] of (revision.content.calculation?.growth ?? []).entries()) if (row.classRef) check(row.classRef, `${label}.buildRevisions.${id}.content.calculation.growth.${index}.classRef`)
    for (const [index, ref] of (revision.content.calculation?.statuses ?? []).entries()) check(ref, `${label}.buildRevisions.${id}.content.calculation.statuses.${index}`)
    if (revision.content.calculation?.ability) check(revision.content.calculation.ability, `${label}.buildRevisions.${id}.content.calculation.ability`)
    for (const { ref, path } of battleCalculationReferences(revision.content.calculation?.battle)) check(ref, `${label}.buildRevisions.${id}.content.calculation.battle.${path}`)
    for (const [slotId, selection] of Object.entries(revision.content.equipment)) {
      if (selection) check(selection.ref, `${label}.buildRevisions.${id}.content.equipment.${slotId}.ref`)
    }
    for (const [index, selection] of revision.content.passives.entries()) check(selection.ref, `${label}.buildRevisions.${id}.content.passives.${index}.ref`)
  }
  for (const [playthroughId, playthrough] of Object.entries(localData.playthroughs)) {
    const playthroughLabel = `${label}.playthroughs.${playthroughId}`
    for (const capture of Object.values(playthrough.skillTreeCaptures ?? {})) {
      check(capture.classRef, `${playthroughLabel}.skillTreeCaptures.${capture.id}.classRef`)
      for (const mapping of capture.mappings) check(mapping.ref, `${playthroughLabel}.skillTreeCaptures.${capture.id}.mappings`)
    }
    for (const [id, position] of Object.entries(playthrough.inventory)) check(position.ref, `${playthroughLabel}.inventory.${id}.ref`)
    for (const [id, event] of Object.entries(playthrough.inventoryEvents)) check(event.ref, `${playthroughLabel}.inventoryEvents.${id}.ref`)
    for (const [characterId, character] of Object.entries(playthrough.characters)) {
      for (const [snapshotId, snapshot] of Object.entries(character.snapshots)) {
        const calculationLabel = `${playthroughLabel}.characters.${characterId}.snapshots.${snapshotId}.calculation`
        for (const [index, row] of (snapshot.calculation?.growth ?? []).entries()) if (row.classRef) check(row.classRef, `${calculationLabel}.growth.${index}.classRef`)
        for (const [index, ref] of (snapshot.calculation?.statuses ?? []).entries()) check(ref, `${calculationLabel}.statuses.${index}`)
        if (snapshot.calculation?.ability) check(snapshot.calculation.ability, `${calculationLabel}.ability`)
        for (const { ref, path } of battleCalculationReferences(snapshot.calculation?.battle)) check(ref, `${calculationLabel}.battle.${path}`)
        for (const ref of knowledgeValues(snapshot.primaryClass)) check(ref, `${playthroughLabel}.characters.${characterId}.snapshots.${snapshotId}.primaryClass`)
        for (const ref of knowledgeValues(snapshot.secondaryClass)) check(ref, `${playthroughLabel}.characters.${characterId}.snapshots.${snapshotId}.secondaryClass`)
        for (const [slotId, ref] of Object.entries(snapshot.equipment)) {
          if (ref) check(ref, `${playthroughLabel}.characters.${characterId}.snapshots.${snapshotId}.equipment.${slotId}`)
        }
        for (const [claimIndex, refs] of knowledgeValues(snapshot.passives).entries()) {
          for (const [index, ref] of refs.entries()) check(ref, `${playthroughLabel}.characters.${characterId}.snapshots.${snapshotId}.passives.${claimIndex}.${index}`)
        }
      }
      for (const [key, progress] of Object.entries(character.classProgress)) check(progress.classRef, `${playthroughLabel}.characters.${characterId}.classProgress.${key}.classRef`)
      for (const [key, learned] of Object.entries(character.learnedNodes)) check(learned.ref, `${playthroughLabel}.characters.${characterId}.learnedNodes.${key}.ref`)
    }
    for (const [id, progress] of Object.entries(playthrough.progress)) check(progress.subject, `${playthroughLabel}.progress.${id}.subject`)
    for (const [goalId, goal] of Object.entries(playthrough.goals)) {
      for (const [index, requirement] of goal.requirements.entries()) {
        if (requirement.target) check(requirement.target, `${playthroughLabel}.goals.${goalId}.requirements[${index}].target`)
      }
    }
  }
}

function validateLocalData(
  value: unknown,
  catalogs: ReadonlyMap<string, ReadonlySet<string>>,
  label = 'localData',
  catalogEntityKinds: ReadonlyMap<string, CatalogEntityKind> = new Map(),
): LocalData {
  const localData = recordValue(value, label)
  const typedLocalData = value as LocalData
  const personalDefinitions = assertIdMap(localData.personalDefinitions, `${label}.personalDefinitions`)
  const gameSetups = assertIdMap(localData.gameSetups, `${label}.gameSetups`)
  const builds = assertIdMap(localData.builds, `${label}.builds`)
  const buildRevisions = assertIdMap(localData.buildRevisions, `${label}.buildRevisions`)
  const playthroughs = assertIdMap(localData.playthroughs, `${label}.playthroughs`)
  assertIdMap(localData.importReceipts, `${label}.importReceipts`)
  validatePersonalDefinitionLineage(typedLocalData, catalogEntityKinds)

  for (const gameSetup of Object.values(typedLocalData.gameSetups)) {
    try { assertModConfiguration(gameSetup) } catch (error) { schemaError(error instanceof Error ? error.message : 'Invalid mod configuration') }
  }
  if (localData.skillTreeLayouts) assertIdMap(localData.skillTreeLayouts, `${label}.skillTreeLayouts`)
  const definitionKind = (ref: EntityRef) => ref.kind === 'personal' ? typedLocalData.personalDefinitions[ref.definitionId]?.kind : catalogEntityKinds.get(entityDefinitionKey(ref))
  for (const entry of Object.values(typedLocalData.skillTreeLayouts ?? {})) {
    if (definitionKind(entry.classRef) !== 'class') schemaError('A skill tree references an unavailable class')
    if (entry.gameSetupRevisionId && !gameSetups[entry.gameSetupRevisionId]) schemaError('A skill tree references a missing Game Setup')
    const positions = entry.shape.split(',').map(key => { const [row, column] = key.split(':').map(Number); return { row, column } })
    try { assertSkillTreeGeometry(positions) } catch { schemaError('A skill layout has invalid square positions') }
    const shape = skillTreeShape(positions)
    if (shape !== entry.shape) schemaError('A skill layout has an invalid shape')
    const mapped = new Set<string>()
    const refs = new Set<string>()
    for (const mapping of entry.mappings) {
      const position = squareKey(mapping)
      const key = logicalEntityKey(typedLocalData, mapping.ref)
      if (!shape.split(',').includes(position) || mapped.has(position) || refs.has(key) || definitionKind(mapping.ref) !== mapping.kind) schemaError('A skill tree contains an invalid or duplicate mapping')
      mapped.add(position)
      refs.add(key)
    }
  }
  if (localData.selectedPlaythroughId !== undefined && !playthroughs[stringValue(localData.selectedPlaythroughId, `${label}.selectedPlaythroughId`)]) {
    schemaError(`${label}.selectedPlaythroughId references a missing Playthrough`)
  }
  if (localData.planningGameSetupRevisionId !== undefined && !gameSetups[stringValue(localData.planningGameSetupRevisionId, `${label}.planningGameSetupRevisionId`)]) {
    schemaError(`${label}.planningGameSetupRevisionId references a missing Game Setup`)
  }
  for (const [id, gameSetup] of Object.entries(gameSetups)) {
    const lock = recordValue(gameSetup.catalogLock, `${label}.gameSetups.${id}.catalogLock`)
    for (const [catalogId, revisionId] of Object.entries(lock)) {
      if (typeof revisionId !== 'string' || !catalogs.has(catalogSnapshotKey(catalogId, revisionId))) {
        schemaError('A Game Setup references a missing catalog revision', { id, catalogId, revisionId })
      }
    }
    const overrideKeys = new Set<string>()
    for (const ref of (gameSetup.definitionOverrides ?? []) as readonly EntityRef[]) {
      const key = logicalEntityKey(typedLocalData, ref)
      if (overrideKeys.has(key)) schemaError('A Game Setup pins duplicate logical definition overrides', { id })
      overrideKeys.add(key)
      const rootRef = definitionLineageRootRef(typedLocalData, ref)
      if (rootRef.kind === 'catalog' && lock[rootRef.catalogId] !== rootRef.catalogRevisionId) {
        schemaError('A Game Setup definition override falls outside its catalog lock', { id })
      }
    }
    const slotIds = new Set<string>()
    for (const slotValue of gameSetup.slots as readonly unknown[]) {
      const slot = recordValue(slotValue, `${label}.gameSetups.${id}.slots`)
      const slotId = stringValue(slot.id, `${label}.gameSetups.${id}.slots.id`)
      if (slotIds.has(slotId)) schemaError('A Game Setup contains duplicate slot identities', { id, slotId })
      slotIds.add(slotId)
    }
  }
  for (const [id, build] of Object.entries(builds)) {
    const gameSetupId = stringValue(build.gameSetupId, `${label}.builds.${id}.gameSetupId`)
    if (!Object.values(gameSetups).some(gameSetup => gameSetup.gameSetupId === gameSetupId)) {
      schemaError('A Build references a missing Game Setup', { id })
    }
    if (
      build.latestRevisionId !== undefined &&
      !buildRevisions[stringValue(build.latestRevisionId, `${label}.builds.${id}.latestRevisionId`)]
    ) {
      schemaError('A build references a missing latest revision', { id })
    }
    if (build.latestRevisionId !== undefined) {
      const latest = buildRevisions[build.latestRevisionId as string]
      if (latest?.buildId !== id) schemaError('A build latest revision belongs to another build', { id })
      if (latest && gameSetups[latest.gameSetupRevisionId as string]?.gameSetupId !== gameSetupId) schemaError('A Build identity does not match its latest behavior preset', { id })
    }
  }
  for (const [id, revision] of Object.entries(buildRevisions)) {
    const buildId = stringValue(revision.buildId, `${label}.buildRevisions.${id}.buildId`)
    if (!builds[buildId]) {
      schemaError('A build revision references a missing build', { id })
    }
    if (
      revision.parentRevisionId !== undefined &&
      !buildRevisions[stringValue(revision.parentRevisionId, `${label}.buildRevisions.${id}.parentRevisionId`)]
    ) {
      schemaError('A build revision references a missing parent revision', { id })
    }
    if (revision.parentRevisionId !== undefined && buildRevisions[revision.parentRevisionId as string]?.buildId !== buildId) {
      schemaError('A build revision parent belongs to another build', { id })
    }
    const gameSetupRevisionId = stringValue(revision.gameSetupRevisionId, `${label}.buildRevisions.${id}.gameSetupRevisionId`)
    const gameSetup = gameSetups[gameSetupRevisionId]
    if (!gameSetup) {
      schemaError('A Build revision references a missing Game Setup', { id })
    }
    const lock = recordValue(revision.catalogLock, `${label}.buildRevisions.${id}.catalogLock`)
    for (const [catalogId, revisionId] of Object.entries(lock)) {
      if (typeof revisionId !== 'string' || !catalogs.has(catalogSnapshotKey(catalogId, revisionId))) {
        schemaError('A build revision references a missing catalog revision', { id, catalogId, revisionId })
      }
    }
    const slotIds = new Set((gameSetup.slots as readonly Record<string, unknown>[]).map((slot) => slot.id as string))
    const content = recordValue(revision.content, `${label}.buildRevisions.${id}.content`)
    validatePinnedReferences(typedLocalData, content, lock, `${label}.buildRevisions.${id}.content`)
    const equipment = recordValue(content.equipment, `${label}.buildRevisions.${id}.content.equipment`)
    for (const slotId of Object.keys(equipment)) {
      if (!slotIds.has(slotId)) schemaError('A Build revision selects an unknown Game Setup slot', { id, slotId })
    }
  }

  const teams = assertIdMap(typedLocalData.teams, `${label}.teams`)
  for (const [id, team] of Object.entries(teams)) {
    for (const revisionId of team.slots as readonly (string | null)[]) if (revisionId && !buildRevisions[revisionId]) schemaError('A Team references a missing build checkpoint', { id, revisionId })
  }
  for (const [playthroughId, playthrough] of Object.entries(playthroughs)) {
    const playthroughLabel = `${label}.playthroughs.${playthroughId}`
    const inventory = assertIdMap(playthrough.inventory, `${playthroughLabel}.inventory`)
    const events = assertIdMap(playthrough.inventoryEvents, `${playthroughLabel}.inventoryEvents`)
    const characters = assertIdMap(playthrough.characters, `${playthroughLabel}.characters`)
    assertIdMap(playthrough.progress, `${playthroughLabel}.progress`)
    const scenarios = assertIdMap(playthrough.scenarios, `${playthroughLabel}.scenarios`)
    assertIdMap(playthrough.goals, `${playthroughLabel}.goals`)
    const typedPlaythrough = typedLocalData.playthroughs[playthroughId]!
    if (playthrough.currentGameSetupRevisionId !== undefined && !gameSetups[stringValue(playthrough.currentGameSetupRevisionId, `${playthroughLabel}.currentGameSetupRevisionId`)]) {
      schemaError('A Playthrough references a missing current Game Setup')
    }
    if (playthrough.activeScenarioId !== undefined && !scenarios[stringValue(playthrough.activeScenarioId, `${playthroughLabel}.activeScenarioId`)]) {
      schemaError('A Playthrough references a missing active scenario')
    }
    const inventoryRefKeys = new Set<string>()
    for (const [id, position] of Object.entries(inventory)) {
      const refKey = logicalEntityKey(typedLocalData, position.ref as EntityRef)
      if (inventoryRefKeys.has(refKey)) schemaError('Inventory contains duplicate positions for one entity', { playthroughId, id })
      inventoryRefKeys.add(refKey)
      const quantity = recordValue(position.quantity, `${playthroughLabel}.inventory.${id}.quantity`)
      const protectedQuantity = position.protectedQuantity as number
      if (position.possession === 'notOwned' && (quantity.kind !== 'exact' || quantity.value !== 0 || protectedQuantity !== 0)) {
        schemaError('Not-owned inventory is not normalized to exact zero stock', { playthroughId, id })
      }
      if (position.possession === 'unknown' && quantity.kind !== 'unknown') {
        schemaError('Unknown possession cannot assert a stock quantity', { playthroughId, id })
      }
      if (position.possession === 'owned' && (quantity.kind === 'unknown' || (quantity.kind === 'exact' && quantity.value === 0))) {
        schemaError('Owned inventory must establish a positive quantity', { playthroughId, id })
      }
      if (quantity.kind === 'exact' && protectedQuantity > (quantity.value as number)) {
        schemaError('Protected inventory exceeds exact stock', { playthroughId, id })
      }
    }
    for (const [id, event] of Object.entries(events)) {
      if (event.positionId === undefined) continue
      const position = inventory[stringValue(event.positionId, `${playthroughLabel}.inventoryEvents.${id}.positionId`)]
      if (!position) schemaError('An inventory event references a missing position', { playthroughId, id })
      if (logicalEntityKey(typedLocalData, position.ref as EntityRef) !== logicalEntityKey(typedLocalData, event.ref as EntityRef)) {
        schemaError('An inventory event does not match its linked position', { playthroughId, id })
      }
    }
    for (const [id, character] of Object.entries(characters)) {
      const snapshots = assertIdMap(character.snapshots, `${playthroughLabel}.characters.${id}.snapshots`)
      for (const [snapshotId, snapshot] of Object.entries(snapshots)) {
        if (snapshot.gameSetupRevisionId !== undefined && !gameSetups[stringValue(snapshot.gameSetupRevisionId, `${playthroughLabel}.characters.${id}.snapshots.${snapshotId}.gameSetupRevisionId`)]) {
          schemaError('A character snapshot references a missing Game Setup revision', { playthroughId, id, snapshotId })
        }
      }
      if (character.currentSnapshotId !== undefined && !snapshots[stringValue(character.currentSnapshotId, `${playthroughLabel}.characters.${id}.currentSnapshotId`)]) {
        schemaError('A character references a missing current snapshot', { playthroughId, id })
      }
      for (const [key, entryValue] of Object.entries(recordValue(character.classProgress, `${playthroughLabel}.characters.${id}.classProgress`))) {
        const entry = recordValue(entryValue, `${playthroughLabel}.characters.${id}.classProgress.${key}`)
        if (key !== logicalEntityKey(typedLocalData, entry.classRef as EntityRef)) schemaError('Character class progress has an unstable reference key', { playthroughId, id, key })
      }
      for (const [key, entryValue] of Object.entries(recordValue(character.learnedNodes, `${playthroughLabel}.characters.${id}.learnedNodes`))) {
        const entry = recordValue(entryValue, `${playthroughLabel}.characters.${id}.learnedNodes.${key}`)
        if (key !== logicalEntityKey(typedLocalData, entry.ref as EntityRef)) schemaError('Character learning has an unstable reference key', { playthroughId, id, key })
      }
    }
    if (playthrough.skillTreeCaptures) assertIdMap(playthrough.skillTreeCaptures, `${playthroughLabel}.skillTreeCaptures`)
    for (const capture of Object.values(typedPlaythrough.skillTreeCaptures ?? {})) {
      if (!characters[capture.characterId]) schemaError('A skill tree references a missing character', { playthroughId, captureId: capture.id })
      if (definitionKind(capture.classRef) !== 'class') schemaError('A skill tree references an unavailable class')
      if (capture.gameSetupRevisionId && !gameSetups[capture.gameSetupRevisionId]) schemaError('A skill tree references a missing Game Setup')
      try { assertSkillTreeGeometry(capture.squares) } catch { schemaError('A skill tree has invalid square positions') }
      const shape = skillTreeShape(capture.squares)
      const mapped = new Set<string>()
      const refs = new Set<string>()
      for (const mapping of capture.mappings) {
        const position = squareKey(mapping)
        const key = logicalEntityKey(typedLocalData, mapping.ref)
        if (!shape.split(',').includes(position) || mapped.has(position) || refs.has(key) || definitionKind(mapping.ref) !== mapping.kind) schemaError('A skill tree contains an invalid or duplicate mapping')
        mapped.add(position)
        refs.add(key)
      }
    }
    for (const [id, scenario] of Object.entries(scenarios)) {
      if (!gameSetups[stringValue(scenario.gameSetupRevisionId, `${playthroughLabel}.scenarios.${id}.gameSetupRevisionId`)]) {
        schemaError('A scenario references a missing Game Setup', { playthroughId, id })
      }
      const lock = recordValue(scenario.catalogLock, `${playthroughLabel}.scenarios.${id}.catalogLock`)
      for (const [catalogId, revisionId] of Object.entries(lock)) {
        if (typeof revisionId !== 'string' || !catalogs.has(catalogSnapshotKey(catalogId, revisionId))) schemaError('A scenario references a missing catalog revision', { playthroughId, id, catalogId, revisionId })
      }
      if (!Array.isArray(scenario.memberIds) || scenario.memberIds.length !== TEAM_SIZE) schemaError(`A scenario team must contain exactly ${TEAM_SIZE} characters`, { playthroughId, id })
      const memberIds = scenario.memberIds.map((characterId, index) => stringValue(characterId, `${playthroughLabel}.scenarios.${id}.memberIds[${index}]`))
      if (new Set(memberIds).size !== TEAM_SIZE) schemaError('A scenario team contains duplicate characters', { playthroughId, id })
      for (const characterId of memberIds) if (!characters[characterId]) schemaError('A scenario team references a missing character', { playthroughId, id, characterId })
      const validateAssignments = (assignments: Record<string, unknown>, baseline = false) => {
        for (const [characterId, revisionId] of Object.entries(assignments)) {
          if (!characters[characterId]) schemaError(`A scenario${baseline ? ' baseline' : ''} assignment references a missing character`, { playthroughId, id, characterId })
          if (!memberIds.includes(characterId)) schemaError(`A scenario${baseline ? ' baseline' : ''} assignment is outside its team`, { playthroughId, id, characterId })
          if ((!baseline && revisionId === null)) continue
          if (typeof revisionId !== 'string' || !buildRevisions[revisionId]) schemaError(`A scenario${baseline ? ' baseline' : ''} references a missing Build revision`, { playthroughId, id, revisionId })
        }
      }
      validateAssignments(recordValue(scenario.assignments, `${playthroughLabel}.scenarios.${id}.assignments`))
      const baseline = recordValue(scenario.baseline, `${playthroughLabel}.scenarios.${id}.baseline`)
      if (baseline.kind === 'recordedParty') {
        if ((baseline.playthroughRevision as number) > typedPlaythrough.revision) schemaError('A scenario baseline references a future Playthrough revision', { playthroughId, id })
        validateAssignments(recordValue(baseline.assignments, `${playthroughLabel}.scenarios.${id}.baseline.assignments`), true)
      }
    }
  }

  let priorNextRevision: number | undefined
  for (const [index, changeValue] of typedLocalData.changes.entries()) {
    const change = recordValue(changeValue, `${label}.changes[${index}]`)
    const previousRevision = revisionValue(change.previousRevision, `${label}.changes[${index}].previousRevision`)
    const nextRevision = revisionValue(change.nextRevision, `${label}.changes[${index}].nextRevision`)
    if (nextRevision !== previousRevision + 1 || (priorNextRevision !== undefined && previousRevision !== priorNextRevision)) {
      schemaError('LocalData change history has a discontinuous revision sequence', { index })
    }
    priorNextRevision = nextRevision
  }
  if (priorNextRevision !== undefined && priorNextRevision !== typedLocalData.revision) {
    schemaError('LocalData change history does not end at the localData revision')
  }
  validateLocalDataEntityRefs(typedLocalData, catalogs, new Set(Object.keys(personalDefinitions)), label)
  return typedLocalData
}

function validateLineage(value: unknown, localDataId: LocalDataId): LocalDataLineage {
  const lineage = recordValue(value, 'lineage')
  if (!lineage.rootLocalDataId) schemaError('Backup lineage is missing its root localData identity', { localDataId })
  return value as LocalDataLineage
}

function validateEvidence(values: readonly unknown[]): readonly EvidenceRecord[] {
  const ids = new Set<string>()
  return values.map((value, index) => {
    const record = recordValue(value, `evidence[${index}]`)
    const id = stringValue(record.id, `evidence[${index}].id`)
    if (ids.has(id)) schemaError('The backup contains duplicate evidence IDs', { id })
    ids.add(id)
    stringValue(record.sourceDigest, `evidence[${index}].sourceDigest`)
    stringValue(record.locator, `evidence[${index}].locator`)
    if (!['reference', 'personal', 'mixed', 'ignored'].includes(String(record.group))) {
      schemaError(`evidence[${index}].group is invalid`)
    }
    return value as EvidenceRecord
  })
}

function validateHistory(
  values: readonly unknown[],
  localData: LocalData,
  catalogs: ReadonlyMap<string, ReadonlySet<string>>,
  catalogEntityKinds: ReadonlyMap<string, CatalogEntityKind>,
): readonly PersistedHistoryEntry[] {
  const ids = new Set<string>()
  if (values.length > MAX_NATIVE_HISTORY) schemaError('The backup history exceeds the retention limit')
  const entries = values.map((value, index) => {
    const record = recordValue(value, `history[${index}]`)
    const id = stringValue(record.id, `history[${index}].id`)
    if (ids.has(id)) schemaError('The backup contains duplicate history IDs', { id })
    ids.add(id)
    if (stringValue(record.localDataId, `history[${index}].localDataId`) !== localData.id) {
      schemaError('A history entry belongs to different planner data', { id })
    }
    const before = validateLocalData(record.before, catalogs, `history[${index}].before`, catalogEntityKinds)
    const after = validateLocalData(record.after, catalogs, `history[${index}].after`, catalogEntityKinds)
    const previousRevision = revisionValue(record.previousRevision, `history[${index}].previousRevision`)
    const nextRevision = revisionValue(record.nextRevision, `history[${index}].nextRevision`)
    if (before.revision !== previousRevision || after.revision !== nextRevision) {
      schemaError('A history entry revision does not match its snapshots', { id })
    }
    if (before.id !== localData.id || after.id !== localData.id) {
      schemaError('A history entry snapshot belongs to different planner data', { id })
    }
    if (nextRevision <= previousRevision) {
      schemaError('A history entry must advance the localData revision', { id })
    }
    const prior = index > 0 ? values[index - 1] as PersistedHistoryEntry : undefined
    if (prior && (previousRevision !== prior.nextRevision || !jsonEqual(prior.after, before))) {
      schemaError('Backup history is not a connected revision suffix', { id, index })
    }
    return value as PersistedHistoryEntry
  })
  const latest = entries.at(-1)
  if (latest && (latest.nextRevision !== localData.revision || !jsonEqual(latest.after, localData))) {
    schemaError('Backup history does not end at the exported localData revision')
  }
  if (!latest && localData.changes.length > 0) {
    schemaError('A localData with a change journal must include its latest undo checkpoint')
  }
  return entries
}

export function validateNativeLocalDataGraph(
  localData: LocalData,
  catalogs: readonly CatalogSnapshot[],
  history?: readonly PersistedHistoryEntry[],
): void {
  validateNativeLocalDataShape(localData)
  for (const catalog of catalogs) {
    if (!validatedImmutableCatalogs.has(catalog) && !NativeCatalogSnapshotSchema.safeParse(catalog).success) schemaError('A transformed catalog has an unsupported shape')
  }
  const gameSetups = [localData, ...(history ?? []).flatMap(entry => [entry.before, entry.after])].flatMap(value => Object.values(value.gameSetups))
  const origins = new Map(gameSetups.map(value => [modCatalogRevision(value.id), value]))
  const checkedOrigins = new Set<string>()
  for (const gameSetup of gameSetups) {
    if (!gameSetup.modComposition) continue
    try {
      const origin = origins.get(gameSetup.catalogLock[gameSetup.modComposition.baseline.catalogId]!)
      if (!origin || !jsonEqual(gameSetup.modComposition, origin.modComposition)) schemaError('An effective mod catalog has no matching originating Game Setup')
      if (checkedOrigins.has(origin.id)) continue
      const expected = composeModCatalog(origin, catalogs)!
      const actual = modCatalogForPin(catalogs, { catalogId: expected.id, catalogRevisionId: expected.revisionId })
      const expanded = expandModCatalogs([modCatalogForPin(catalogs, gameSetup.modComposition.baseline)!, expected])[1]!
      if (!actual || (!jsonEqual({ ...actual, checksum: expected.checksum }, expected) && !jsonEqual({ ...actual, checksum: expected.checksum }, expanded))) schemaError('An effective mod catalog does not match its pinned source layers')
      checkedOrigins.add(origin.id)
    } catch (error) { schemaError(error instanceof Error ? error.message : 'Invalid imported mod composition') }
  }
  const validatedCatalogs = validateCatalogs(catalogs)
  const validatedLocalData = validateLocalData(localData, validatedCatalogs.keys, 'localData', validatedCatalogs.entityKinds)
  if (history) {
    for (const entry of history) {
      if (!NativeHistorySchema.safeParse(entry).success) schemaError('A transformed history entry has an unsupported shape')
    }
    validateHistory(history, validatedLocalData, validatedCatalogs.keys, validatedCatalogs.entityKinds)
  }
}

export function validateNativeLocalDataShape(localData: LocalData): void {
  const result = NativeLocalDataSchema.safeParse(localData)
  if (!result.success) {
    schemaError('The transformed localData has an unsupported shape', {
      issues: result.error.issues.slice(0, 20).map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    })
  }
}

export function resolveBundledCatalogPins(pins: readonly Pick<CatalogSnapshot, 'id' | 'revisionId' | 'checksum'>[], available: readonly CatalogSnapshot[]): readonly CatalogSnapshot[] {
  const keys = new Set<string>()
  return pins.map(pin => {
    const key = catalogSnapshotKey(pin.id, pin.revisionId)
    if (keys.has(key)) schemaError('The backup contains a duplicate bundled catalog pin', { catalogId: pin.id, revisionId: pin.revisionId })
    keys.add(key)
    const catalog = available.find(candidate => candidate.id === pin.id && candidate.revisionId === pin.revisionId)
    if (!catalog || catalog.checksum !== pin.checksum) schemaError('The exact bundled catalog revision required by this backup is unavailable or has a different checksum', { catalogId: pin.id, revisionId: pin.revisionId })
    return catalog
  })
}

export async function previewNativeBackup(bytes: Uint8Array, filename: string, availableBundledCatalogs: readonly CatalogSnapshot[] = []): Promise<ImportPreview> {
  const { files } = safeUnzip(bytes, { limits: NATIVE_BACKUP_ARCHIVE_LIMITS })
  const manifestValue = parseBoundedJson(
    files.get('manifest.json') ?? schemaError('The native backup is missing manifest.json'),
    'manifest.json',
  )
  const manifestResult = NativeManifestSchema.safeParse(manifestValue)
  if (!manifestResult.success) {
    throw new AppDataError('schema-mismatch', 'The native backup manifest is invalid or from an unsupported version', {
      recoverable: true,
      details: { issues: manifestResult.error.issues.slice(0, 20).map((issue) => `${issue.path.join('.')}: ${issue.message}`) },
    })
  }
  const parsedManifest = manifestResult.data
  const manifest: NativeBackupManifest = {
    ...parsedManifest,
    exportedAt: parsedManifest.exportedAt as Timestamp,
    sources: parsedManifest.sources.map((source) => ({
      ...source,
      importedAt: source.importedAt as Timestamp,
    })),
  }
  const sourceIds = new Set<string>()
  const sourcePaths = new Set<string>()
  for (const source of manifest.sources) {
    if (sourceIds.has(source.id) || sourcePaths.has(source.path)) {
      schemaError('The native backup manifest contains duplicate source identities or paths')
    }
    sourceIds.add(source.id)
    sourcePaths.add(source.path)
  }
  const allowedPaths = new Set(['manifest.json', manifest.payload, ...manifest.sources.map((source) => source.path)])
  const unexpected = Array.from(files.keys()).filter((path) => !allowedPaths.has(path))
  if (unexpected.length > 0 || files.size !== allowedPaths.size) {
    schemaError('The native backup contains unexpected or missing files', { unexpected })
  }
  const payloadValue = parseBoundedJson(
    files.get(manifest.payload) ?? schemaError('The native backup payload is missing'),
    manifest.payload,
    NATIVE_BACKUP_JSON_LIMITS,
  )
  const payloadResult = NativePayloadSchema.safeParse(payloadValue)
  if (!payloadResult.success) {
    throw new AppDataError('schema-mismatch', 'The native backup payload has an unsupported shape', {
      recoverable: true,
      details: { issues: payloadResult.error.issues.slice(0, 20).map((issue) => `${issue.path.join('.')}: ${issue.message}`) },
    })
  }
  if (manifest.formatVersion === '2.0.0' && payloadResult.data.bundledCatalogs !== undefined) schemaError('Bundled catalog pins require backup format 2.1.0')
  const pinnedCatalogs = resolveBundledCatalogPins((payloadResult.data.bundledCatalogs ?? []) as unknown as readonly Pick<CatalogSnapshot, 'id' | 'revisionId' | 'checksum'>[], availableBundledCatalogs)
  const allCatalogs = [...payloadResult.data.catalogs as unknown as readonly CatalogSnapshot[], ...pinnedCatalogs]
  const catalogs = validateCatalogs(allCatalogs)
  const localData = validateLocalData(payloadResult.data.localData, catalogs.keys, 'localData', catalogs.entityKinds)
  const lineage = validateLineage(payloadResult.data.lineage, localData.id)
  const evidence = validateEvidence(payloadResult.data.evidence)
  const history = validateHistory(payloadResult.data.history, localData, catalogs.keys, catalogs.entityKinds)
  const sources: SourceArchiveRecord[] = []
  for (const source of manifest.sources) {
    const sourceBytes = files.get(source.path) ?? schemaError('A source file listed by the backup is missing')
    if (sourceBytes.byteLength !== source.size || await sha256(sourceBytes) !== source.digest) {
      schemaError('A source file failed backup checksum validation', { path: source.path })
    }
    sources.push({
      id: source.id,
      digest: source.digest,
      filename: source.filename,
      mediaType: source.mediaType,
      format: source.format,
      importedAt: source.importedAt,
      bytes: Uint8Array.from(sourceBytes),
    })
  }
  const sourceDigests = new Set(sources.map((source) => source.digest))
  for (const entry of evidence) {
    if (!sourceDigests.has(entry.sourceDigest)) {
      schemaError('Evidence references a source archive that is missing from the backup', {
        evidenceId: entry.id,
        sourceDigest: entry.sourceDigest,
      })
    }
  }
  validateNativeLocalDataGraph(localData, allCatalogs, history)
  const digest = await sha256(bytes)
  const personalCount = Object.values(localData.playthroughs).reduce((total, playthrough) => total +
    Object.keys(playthrough.inventory).length +
    Object.keys(playthrough.inventoryEvents).length +
    Object.keys(playthrough.characters).length +
    Object.keys(playthrough.progress).length +
    Object.keys(playthrough.quintarBreeding ?? {}).length +
    Object.keys(playthrough.scenarios).length +
    Object.keys(playthrough.goals).length, Object.keys(localData.builds).length)
  return {
    id: randomId('import-preview'),
    filename,
    detectedFormat: manifest.formatVersion === '2.0.0' ? 'native-backup-2.0.0' : 'native-backup-2.1.0',
    detectedSchema: manifest.formatVersion,
    sourceDigest: digest,
    counts: {
      reference: catalogs.snapshots.reduce((total, catalog) => total + Object.keys(catalog.entities).length, 0),
      personal: personalCount,
      mixed: evidence.filter((entry) => entry.group === 'mixed').length,
      ignored: 0,
    },
    warnings: [
      {
        severity: 'warning',
        code: 'replace-local-data',
        message: 'Restoring this backup replaces the local planner data after confirmation',
      },
      ...(manifest.history?.truncated
        ? [{
            severity: 'warning' as const,
            code: 'bounded-history',
            message: `This backup retains the newest ${manifest.history.exported} of ${manifest.history.stored} undo checkpoints`,
          }]
        : []),
    ],
    errors: [],
    localData: {
      label: localData.selectedPlaythroughId
        ? localData.playthroughs[localData.selectedPlaythroughId]?.label ?? 'Imported planner data'
        : 'Imported planner data',
      identity: localData.id,
      ancestry: lineage,
    },
    proposed: {
      localData,
      lineage,
      catalogs: catalogs.snapshots,
      evidence,
      sources,
      history,
    },
  }
}

export function nativeBackupTimestamp(): Timestamp {
  return nowTimestamp()
}

export function isNativeManifest(value: JsonValue): boolean {
  return isJsonObject(value) && value.format === 'crykit-backup'
}

export const localDataIdFromNative = (value: string): LocalDataId => asLocalDataId(value)
