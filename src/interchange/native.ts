import type { CatalogSnapshot, EntityRef, JsonValue, Knowledge, Profile, ProfileId, Timestamp } from '../domain/types'
import { entityRefKey } from '../domain/core'
import { AppDataError } from './errors'
import { isJsonObject, parseBoundedJson } from './json'
import {
  NativeCatalogSnapshotSchema,
  NativeHistorySchema,
  NativeManifestSchema,
  NativePayloadSchema,
  NativeProfileSchema,
} from './native-schema'
import { catalogSnapshotKey } from './identity'
import type {
  EvidenceRecord,
  ImportPreview,
  NativeBackupManifest,
  PersistedHistoryEntry,
  ProfileLineage,
  SourceArchiveRecord,
} from './types'
import { asProfileId, nowTimestamp, randomId, sha256 } from './util'
import { safeUnzip } from './zip'

const MAX_NATIVE_HISTORY = 500

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
  for (const [index, value] of values.entries()) {
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
  }
  for (const [index, snapshot] of snapshots.entries()) {
    for (const [entityId, entity] of Object.entries(snapshot.entities)) {
      validateDefinitionRequirements(entity.requirements, keys, new Set(), `catalogs[${index}].entities.${entityId}.requirements`)
    }
  }
  return { snapshots, keys }
}

function validatePinnedReferences(
  value: unknown,
  lock: Readonly<Record<string, unknown>>,
  label: string,
): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validatePinnedReferences(entry, lock, `${label}[${index}]`))
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
  for (const [key, nested] of Object.entries(record)) validatePinnedReferences(nested, lock, `${label}.${key}`)
}

function validateProfileEntityRefs(
  profile: Profile,
  catalogs: ReadonlyMap<string, ReadonlySet<string>>,
  personalDefinitionIds: ReadonlySet<string>,
  label: string,
): void {
  const check = (ref: EntityRef, path: string): void => validateEntityRef(ref, catalogs, personalDefinitionIds, path)
  for (const [id, definition] of Object.entries(profile.personalDefinitions)) {
    validateDefinitionRequirements(definition.requirements, catalogs, personalDefinitionIds, `${label}.personalDefinitions.${id}.requirements`)
  }
  for (const [id, position] of Object.entries(profile.inventory)) check(position.ref, `${label}.inventory.${id}.ref`)
  for (const [id, event] of Object.entries(profile.inventoryEvents)) check(event.ref, `${label}.inventoryEvents.${id}.ref`)
  for (const [characterId, character] of Object.entries(profile.characters)) {
    for (const [snapshotId, snapshot] of Object.entries(character.snapshots)) {
      for (const ref of knowledgeValues(snapshot.primaryClass)) check(ref, `${label}.characters.${characterId}.snapshots.${snapshotId}.primaryClass`)
      for (const ref of knowledgeValues(snapshot.secondaryClass)) check(ref, `${label}.characters.${characterId}.snapshots.${snapshotId}.secondaryClass`)
      for (const [slotId, ref] of Object.entries(snapshot.selections)) {
        if (ref) check(ref, `${label}.characters.${characterId}.snapshots.${snapshotId}.selections.${slotId}`)
      }
    }
    for (const [key, progress] of Object.entries(character.classProgress)) {
      check(progress.classRef, `${label}.characters.${characterId}.classProgress.${key}.classRef`)
    }
    for (const [key, learned] of Object.entries(character.learnedNodes)) {
      check(learned.ref, `${label}.characters.${characterId}.learnedNodes.${key}.ref`)
    }
  }
  for (const [id, progress] of Object.entries(profile.progress)) check(progress.subject, `${label}.progress.${id}.subject`)
  for (const [id, revision] of Object.entries(profile.buildRevisions)) {
    if (revision.content.primaryClass) check(revision.content.primaryClass, `${label}.buildRevisions.${id}.content.primaryClass`)
    if (revision.content.secondaryClass) check(revision.content.secondaryClass, `${label}.buildRevisions.${id}.content.secondaryClass`)
    for (const [slotId, selection] of Object.entries(revision.content.selections)) {
      if (selection) check(selection.ref, `${label}.buildRevisions.${id}.content.selections.${slotId}.ref`)
    }
  }
  for (const [goalId, goal] of Object.entries(profile.goals)) {
    for (const [index, requirement] of goal.requirements.entries()) {
      if (requirement.target) check(requirement.target, `${label}.goals.${goalId}.requirements[${index}].target`)
    }
  }
}

function validateProfile(value: unknown, catalogs: ReadonlyMap<string, ReadonlySet<string>>, label = 'profile'): Profile {
  const profile = recordValue(value, label)
  const typedProfile = value as Profile

  const personalDefinitions = assertIdMap(profile.personalDefinitions, `${label}.personalDefinitions`)
  const rulesets = assertIdMap(profile.rulesets, `${label}.rulesets`)
  const inventory = assertIdMap(profile.inventory, `${label}.inventory`)
  const events = assertIdMap(profile.inventoryEvents, `${label}.inventoryEvents`)
  const characters = assertIdMap(profile.characters, `${label}.characters`)
  assertIdMap(profile.progress, `${label}.progress`)
  const builds = assertIdMap(profile.builds, `${label}.builds`)
  const buildRevisions = assertIdMap(profile.buildRevisions, `${label}.buildRevisions`)
  const scenarios = assertIdMap(profile.scenarios, `${label}.scenarios`)
  assertIdMap(profile.goals, `${label}.goals`)
  assertIdMap(profile.importReceipts, `${label}.importReceipts`)

  if (profile.activeRulesetRevisionId !== undefined && !rulesets[stringValue(profile.activeRulesetRevisionId, `${label}.activeRulesetRevisionId`)]) {
    schemaError(`${label}.activeRulesetRevisionId references a missing ruleset`)
  }
  if (profile.activeScenarioId !== undefined && !scenarios[stringValue(profile.activeScenarioId, `${label}.activeScenarioId`)]) {
    schemaError(`${label}.activeScenarioId references a missing scenario`)
  }
  for (const [id, ruleset] of Object.entries(rulesets)) {
    const lock = recordValue(ruleset.catalogLock, `${label}.rulesets.${id}.catalogLock`)
    for (const [catalogId, revisionId] of Object.entries(lock)) {
      if (typeof revisionId !== 'string' || !catalogs.has(catalogSnapshotKey(catalogId, revisionId))) {
        schemaError('A ruleset references a missing catalog revision', { id, catalogId, revisionId })
      }
    }
    const slotIds = new Set<string>()
    for (const slotValue of ruleset.slots as readonly unknown[]) {
      const slot = recordValue(slotValue, `${label}.rulesets.${id}.slots`)
      const slotId = stringValue(slot.id, `${label}.rulesets.${id}.slots.id`)
      if (slotIds.has(slotId)) schemaError('A ruleset contains duplicate slot identities', { id, slotId })
      slotIds.add(slotId)
    }
  }
  const inventoryRefKeys = new Set<string>()
  for (const [id, position] of Object.entries(inventory)) {
    const ref = position.ref as EntityRef
    const refKey = entityRefKey(ref)
    if (inventoryRefKeys.has(refKey)) schemaError('Inventory contains duplicate positions for one entity', { id })
    inventoryRefKeys.add(refKey)
    const possession = position.possession
    const quantity = recordValue(position.quantity, `${label}.inventory.${id}.quantity`)
    const protectedQuantity = position.protectedQuantity as number
    if (possession === 'notOwned') {
      if (quantity.kind !== 'exact' || quantity.value !== 0 || protectedQuantity !== 0) {
        schemaError('Not-owned inventory is not normalized to exact zero stock', { id })
      }
    } else if (possession === 'unknown') {
      if (quantity.kind !== 'unknown') {
        schemaError('Unknown possession cannot assert a stock quantity', { id })
      }
    } else if (quantity.kind === 'unknown' || (quantity.kind === 'exact' && quantity.value === 0)) {
      schemaError('Owned inventory must establish a positive quantity', { id })
    }
    if (quantity.kind === 'exact' && protectedQuantity > (quantity.value as number)) {
      schemaError('Protected inventory exceeds exact stock', { id })
    }
  }
  for (const [id, event] of Object.entries(events)) {
    if (event.positionId !== undefined) {
      const position = inventory[stringValue(event.positionId, `${label}.inventoryEvents.${id}.positionId`)]
      if (!position) schemaError('An inventory event references a missing position', { id })
      if (entityRefKey(position.ref as EntityRef) !== entityRefKey(event.ref as EntityRef)) {
        schemaError('An inventory event does not match its linked position', { id })
      }
    }
  }
  for (const [id, character] of Object.entries(characters)) {
    const snapshots = assertIdMap(character.snapshots, `${label}.characters.${id}.snapshots`)
    if (
      character.currentSnapshotId !== undefined &&
      !snapshots[stringValue(character.currentSnapshotId, `${label}.characters.${id}.currentSnapshotId`)]
    ) {
      schemaError('A character references a missing current snapshot', { id })
    }
    const classProgress = recordValue(character.classProgress, `${label}.characters.${id}.classProgress`)
    for (const [key, entryValue] of Object.entries(classProgress)) {
      const entry = recordValue(entryValue, `${label}.characters.${id}.classProgress.${key}`)
      if (key !== entityRefKey(entry.classRef as EntityRef)) {
        schemaError('Character class progress has an unstable reference key', { id, key })
      }
    }
    const learnedNodes = recordValue(character.learnedNodes, `${label}.characters.${id}.learnedNodes`)
    for (const [key, entryValue] of Object.entries(learnedNodes)) {
      const entry = recordValue(entryValue, `${label}.characters.${id}.learnedNodes.${key}`)
      if (key !== entityRefKey(entry.ref as EntityRef)) {
        schemaError('Character learning has an unstable reference key', { id, key })
      }
    }
  }
  for (const [id, build] of Object.entries(builds)) {
    if (build.characterId !== undefined && !characters[stringValue(build.characterId, `${label}.builds.${id}.characterId`)]) {
      schemaError('A build references a missing character', { id })
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
    const rulesetId = stringValue(revision.rulesetRevisionId, `${label}.buildRevisions.${id}.rulesetRevisionId`)
    const ruleset = rulesets[rulesetId]
    if (!ruleset) {
      schemaError('A build revision references a missing ruleset', { id })
    }
    const lock = recordValue(revision.catalogLock, `${label}.buildRevisions.${id}.catalogLock`)
    for (const [catalogId, revisionId] of Object.entries(lock)) {
      if (typeof revisionId !== 'string' || !catalogs.has(catalogSnapshotKey(catalogId, revisionId))) {
        schemaError('A build revision references a missing catalog revision', { id, catalogId, revisionId })
      }
    }
    const slotIds = new Set((ruleset.slots as readonly Record<string, unknown>[]).map((slot) => slot.id as string))
    const content = recordValue(revision.content, `${label}.buildRevisions.${id}.content`)
    validatePinnedReferences(content, lock, `${label}.buildRevisions.${id}.content`)
    const selections = recordValue(content.selections, `${label}.buildRevisions.${id}.content.selections`)
    for (const slotId of Object.keys(selections)) {
      if (!slotIds.has(slotId)) schemaError('A build revision selects an unknown ruleset slot', { id, slotId })
    }
  }
  for (const [id, scenario] of Object.entries(scenarios)) {
    if (!rulesets[stringValue(scenario.rulesetRevisionId, `${label}.scenarios.${id}.rulesetRevisionId`)]) {
      schemaError('A scenario references a missing ruleset', { id })
    }
    const lock = recordValue(scenario.catalogLock, `${label}.scenarios.${id}.catalogLock`)
    for (const [catalogId, revisionId] of Object.entries(lock)) {
      if (typeof revisionId !== 'string' || !catalogs.has(catalogSnapshotKey(catalogId, revisionId))) {
        schemaError('A scenario references a missing catalog revision', { id, catalogId, revisionId })
      }
    }
    const assignments = recordValue(scenario.assignments, `${label}.scenarios.${id}.assignments`)
    for (const [characterId, revisionId] of Object.entries(assignments)) {
      if (!characters[characterId]) schemaError('A scenario assignment references a missing character', { id, characterId })
      if (revisionId !== null && (typeof revisionId !== 'string' || !buildRevisions[revisionId])) {
        schemaError('A scenario references a missing build revision', { id, revisionId })
      }
    }
    const baseline = recordValue(scenario.baseline, `${label}.scenarios.${id}.baseline`)
    if (baseline.kind === 'recordedParty') {
      if ((baseline.profileRevision as number) > typedProfile.revision) {
        schemaError('A scenario baseline references a future profile revision', { id })
      }
      const baselineAssignments = recordValue(baseline.assignments, `${label}.scenarios.${id}.baseline.assignments`)
      for (const [characterId, revisionId] of Object.entries(baselineAssignments)) {
        if (!characters[characterId]) schemaError('A scenario baseline references a missing character', { id, characterId })
        if (typeof revisionId !== 'string' || !buildRevisions[revisionId]) {
          schemaError('A scenario baseline references a missing build revision', { id, revisionId })
        }
      }
    }
  }
  let priorNextRevision: number | undefined
  for (const [index, changeValue] of typedProfile.changes.entries()) {
    const change = recordValue(changeValue, `${label}.changes[${index}]`)
    const previousRevision = revisionValue(change.previousRevision, `${label}.changes[${index}].previousRevision`)
    const nextRevision = revisionValue(change.nextRevision, `${label}.changes[${index}].nextRevision`)
    if (nextRevision !== previousRevision + 1 || (priorNextRevision !== undefined && previousRevision !== priorNextRevision)) {
      schemaError('Profile change history has a discontinuous revision sequence', { index })
    }
    priorNextRevision = nextRevision
  }
  if (priorNextRevision !== undefined && priorNextRevision !== typedProfile.revision) {
    schemaError('Profile change history does not end at the profile revision')
  }
  validateProfileEntityRefs(typedProfile, catalogs, new Set(Object.keys(personalDefinitions)), label)
  return typedProfile
}

function validateLineage(value: unknown, profileId: ProfileId): ProfileLineage {
  const lineage = recordValue(value, 'lineage')
  if (!lineage.rootProfileId) schemaError('Backup lineage is missing its root profile identity', { profileId })
  return value as ProfileLineage
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
  profile: Profile,
  catalogs: ReadonlyMap<string, ReadonlySet<string>>,
): readonly PersistedHistoryEntry[] {
  const ids = new Set<string>()
  if (values.length > MAX_NATIVE_HISTORY) schemaError('The backup history exceeds the retention limit')
  const entries = values.map((value, index) => {
    const record = recordValue(value, `history[${index}]`)
    const id = stringValue(record.id, `history[${index}].id`)
    if (ids.has(id)) schemaError('The backup contains duplicate history IDs', { id })
    ids.add(id)
    if (stringValue(record.profileId, `history[${index}].profileId`) !== profile.id) {
      schemaError('A history entry belongs to a different profile', { id })
    }
    const before = validateProfile(record.before, catalogs, `history[${index}].before`)
    const after = validateProfile(record.after, catalogs, `history[${index}].after`)
    const previousRevision = revisionValue(record.previousRevision, `history[${index}].previousRevision`)
    const nextRevision = revisionValue(record.nextRevision, `history[${index}].nextRevision`)
    if (before.revision !== previousRevision || after.revision !== nextRevision) {
      schemaError('A history entry revision does not match its snapshots', { id })
    }
    if (before.id !== profile.id || after.id !== profile.id) {
      schemaError('A history entry snapshot belongs to a different profile', { id })
    }
    if (nextRevision <= previousRevision) {
      schemaError('A history entry must advance the profile revision', { id })
    }
    const prior = index > 0 ? values[index - 1] as PersistedHistoryEntry : undefined
    if (prior && (previousRevision !== prior.nextRevision || !jsonEqual(prior.after, before))) {
      schemaError('Backup history is not a connected revision suffix', { id, index })
    }
    return value as PersistedHistoryEntry
  })
  const latest = entries.at(-1)
  if (latest && (latest.nextRevision !== profile.revision || !jsonEqual(latest.after, profile))) {
    schemaError('Backup history does not end at the exported profile revision')
  }
  if (!latest && profile.changes.length > 0) {
    schemaError('A profile with a change journal must include its latest undo checkpoint')
  }
  return entries
}

export function validateNativeProfileGraph(
  profile: Profile,
  catalogs: readonly CatalogSnapshot[],
  history?: readonly PersistedHistoryEntry[],
): void {
  const profileResult = NativeProfileSchema.safeParse(profile)
  if (!profileResult.success) schemaError('The transformed profile has an unsupported shape')
  for (const catalog of catalogs) {
    if (!NativeCatalogSnapshotSchema.safeParse(catalog).success) schemaError('A transformed catalog has an unsupported shape')
  }
  const validatedCatalogs = validateCatalogs(catalogs)
  const validatedProfile = validateProfile(profile, validatedCatalogs.keys)
  if (history) {
    for (const entry of history) {
      if (!NativeHistorySchema.safeParse(entry).success) schemaError('A transformed history entry has an unsupported shape')
    }
    validateHistory(history, validatedProfile, validatedCatalogs.keys)
  }
}

export async function previewNativeBackup(bytes: Uint8Array, filename: string): Promise<ImportPreview> {
  const { files } = safeUnzip(bytes)
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
  )
  const payloadResult = NativePayloadSchema.safeParse(payloadValue)
  if (!payloadResult.success) {
    throw new AppDataError('schema-mismatch', 'The native backup payload has an unsupported shape', {
      recoverable: true,
      details: { issues: payloadResult.error.issues.slice(0, 20).map((issue) => `${issue.path.join('.')}: ${issue.message}`) },
    })
  }
  const catalogs = validateCatalogs(payloadResult.data.catalogs)
  const profile = validateProfile(payloadResult.data.profile, catalogs.keys)
  const lineage = validateLineage(payloadResult.data.lineage, profile.id)
  const evidence = validateEvidence(payloadResult.data.evidence)
  const history = validateHistory(payloadResult.data.history, profile, catalogs.keys)
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
  const digest = await sha256(bytes)
  const personalCount =
    Object.keys(profile.inventory).length +
    Object.keys(profile.inventoryEvents).length +
    Object.keys(profile.characters).length +
    Object.keys(profile.progress).length +
    Object.keys(profile.builds).length +
    Object.keys(profile.scenarios).length +
    Object.keys(profile.goals).length
  return {
    id: randomId('import-preview'),
    filename,
    detectedFormat: 'native-backup-1.0.0',
    detectedSchema: '1.0.0',
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
        code: 'fork-by-default',
        message: 'Restoring this backup creates a separate profile branch if the same identity already exists',
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
    profile: { label: profile.label, identity: profile.id, ancestry: lineage },
    proposed: {
      profile,
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
  return isJsonObject(value) && value.format === 'crystal-companion-backup'
}

export const profileIdFromNative = (value: string): ProfileId => asProfileId(value)
