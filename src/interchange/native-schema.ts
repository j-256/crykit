import { PC_LEVEL_CAP } from '../domain/calculation-rules'
import { GENDER_SELECTION_VERSION, MAX_GENDER_ID } from '../domain/calculation-genders'
import { CALCULATION_GENDERS } from '../domain/calculation-plan'
import { BATTLE_CALCULATION_VERSION, validateBattleCalculation } from '../domain/battle-plan'
import { MAX_NATIVE_INTEGER } from '../domain/native-number'
import type { BattleCalculationPlan } from '../domain/types'
import { QUINTAR_BREEDING_STEP_IDS } from '../catalog/quintar-breeding'
import { STAT_KEYS } from '../domain/crystal-edit'
import { assertModComposition, MAX_MOD_LAYERS } from '../domain/mod-layers'
import { REFERENCE_LIBRARY_SETTINGS_VERSION } from '../domain/reference-library'
import { z } from 'zod'
import { asTimestamp } from '../domain/core'
import { TEAM_SIZE } from '../domain/scenarios'
import { LOCAL_DATA_SCHEMA_VERSION } from '../domain/types'
import {
  MAX_COLLECTION_LENGTH,
  MAX_ID_LENGTH,
  MAX_LONG_TEXT_LENGTH,
  MAX_SHORT_TEXT_LENGTH,
  MAX_SOURCE_REFS,
} from '../domain/limits'

const id = z.string().min(1).max(MAX_ID_LENGTH).refine(
  (value) => !/[\u0000-\u001f\u007f]/.test(value),
  'IDs cannot contain control characters',
)
const shortText = z.string().max(MAX_SHORT_TEXT_LENGTH)
const nonemptyText = z.string().min(1).max(MAX_SHORT_TEXT_LENGTH)
const longText = z.string().max(MAX_LONG_TEXT_LENGTH)
const safeInteger = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER)
const nonnegativeInteger = safeInteger.nonnegative()
const positiveInteger = safeInteger.positive()
const finiteNumber = z.number().finite()
function isDomainTimestamp(value: string): boolean {
  try {
    asTimestamp(value)
    return true
  } catch {
    return false
  }
}

const timestamp = z.string().max(128).refine(
  (value) => value.includes('T') && isDomainTimestamp(value),
  'Expected a valid ISO 8601 UTC timestamp',
)
const dateOrTimestamp = z.string().max(128).refine(isDomainTimestamp, 'Expected a valid calendar date or ISO 8601 UTC timestamp')

const jsonValue: z.ZodType = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  finiteNumber,
  longText,
  z.array(jsonValue).max(MAX_COLLECTION_LENGTH),
  z.record(z.string().max(MAX_ID_LENGTH), jsonValue),
]))

const sourceRef = z.object({
  sourceId: id,
  locator: shortText.optional(),
  snapshot: shortText.optional(),
  applicability: shortText.optional(),
  checkedAt: dateOrTimestamp.optional(),
}).strict()

const sourceRefs = z.array(sourceRef).max(MAX_SOURCE_REFS)

function knowledge(value: z.ZodType): z.ZodType {
  return z.discriminatedUnion('state', [
    z.object({ state: z.literal('known'), value, sources: sourceRefs.optional() }).strict(),
    z.object({ state: z.literal('unknown'), reason: shortText.optional(), sources: sourceRefs.optional() }).strict(),
    z.object({
      state: z.literal('conflicting'),
      claims: z.array(z.object({ value, sources: sourceRefs, note: shortText.optional() }).strict()).min(2).max(MAX_COLLECTION_LENGTH),
    }).strict(),
    z.object({ state: z.literal('notApplicable'), reason: shortText.optional() }).strict(),
  ])
}

const catalogRef = z.object({
  kind: z.literal('catalog'),
  catalogId: id,
  catalogRevisionId: id,
  entityId: id,
}).strict()

const personalRef = z.object({ kind: z.literal('personal'), definitionId: id }).strict()
const entityRef = z.discriminatedUnion('kind', [catalogRef, personalRef])

const catalogEntityKind = z.enum([
  'item',
  'class',
  'ability',
  'passive',
  'innate',
  'monsterMagic',
  'monster',
  'command',
  'status',
  'recipe',
  'location',
  'other',
])

const numericContribution = z.object({
  value: finiteNumber,
  unit: nonemptyText,
  condition: shortText.optional(),
}).strict()

const entityRequirement = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('permission'), permission: nonemptyText }).strict(),
  z.object({ kind: z.literal('selected'), ref: entityRef }).strict(),
])

const entityFields = z.record(z.string().min(1).max(MAX_ID_LENGTH), knowledge(jsonValue))
const listedContributions = z.record(z.string().min(1).max(MAX_ID_LENGTH), knowledge(numericContribution))
const entityShape = {
  id,
  kind: catalogEntityKind,
  name: nonemptyText,
  aliases: z.array(shortText).max(MAX_COLLECTION_LENGTH),
  fields: entityFields,
  rawDescription: longText.optional(),
  slotKinds: knowledge(z.array(nonemptyText).max(MAX_COLLECTION_LENGTH)).optional(),
  ppCost: knowledge(finiteNumber).optional(),
  listedContributions: listedContributions.optional(),
  requirements: knowledge(z.array(entityRequirement).max(MAX_COLLECTION_LENGTH)).optional(),
  grants: knowledge(z.array(nonemptyText).max(MAX_COLLECTION_LENGTH)).optional(),
  sources: sourceRefs,
}

const catalogEntity = z.object({ ...entityShape, legacy: jsonValue.optional() }).strict()
const catalogClaim = z.object({
  entityId: id,
  field: nonemptyText,
  value: knowledge(jsonValue),
  sources: sourceRefs,
}).strict()

export const NativeCatalogSnapshotSchema = z.object({
  id,
  revisionId: id,
  schemaVersion: nonemptyText,
  checksum: nonemptyText,
  importedAt: timestamp,
  applicability: knowledge(shortText),
  rights: knowledge(shortText),
  entities: z.record(id, catalogEntity),
  claims: z.array(catalogClaim).max(MAX_COLLECTION_LENGTH),
  legacy: jsonValue.optional(),
}).strict()

const personalDefinition = z.object({
  ...entityShape,
  revision: nonnegativeInteger,
  baseRef: entityRef.optional(),
  previousRevision: personalRef.optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict()

const slotDefinition = z.object({
  id,
  kind: z.literal('equipment'),
  label: nonemptyText,
  order: safeInteger,
  equipmentRole: z.enum(['mainHand', 'offHand', 'head', 'body', 'accessory']).nullable().optional(),
  acceptedEntityKinds: knowledge(z.array(catalogEntityKind).max(MAX_COLLECTION_LENGTH)).optional(),
  provenance: z.enum(['verified', 'imported', 'suggested', 'userDefined']),
  sources: sourceRefs,
}).strict()

const catalogLock = z.record(id, id)
const gameSetupRevision = z.object({
  id,
  gameSetupId: id,
  revision: nonnegativeInteger,
  label: nonemptyText,
  platform: knowledge(shortText),
  gameVersion: knowledge(shortText),
  mode: knowledge(shortText),
  difficulty: z.object({ version: z.literal(1), selection: knowledge(nonnegativeInteger) }).strict().optional(),
  mods: knowledge(z.array(shortText).max(MAX_COLLECTION_LENGTH)),
  disabledMods: knowledge(z.array(shortText).max(MAX_COLLECTION_LENGTH)).optional(),
  customMods: z.array(nonemptyText).max(MAX_COLLECTION_LENGTH).optional(),
  ppLimit: knowledge(nonnegativeInteger).optional(),
  ppCostsNonNegative: knowledge(z.boolean()),
  slots: z.array(slotDefinition).max(MAX_COLLECTION_LENGTH),
  catalogLock,
  definitionOverrides: z.array(personalRef).max(MAX_COLLECTION_LENGTH).optional(),
  modSourceReceipts: z.array(z.object({
    catalogId: id,
    catalogRevisionId: id,
    checksum: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    title: nonemptyText,
    contentFingerprint: z.string().regex(/^json-content-v1:sha256:[0-9a-f]{64}$/).optional(),
  }).strict()).max(MAX_MOD_LAYERS).optional(),
  modComposition: z.object({
    version: z.union([z.literal(2), z.literal(3)]).optional(),
    identityMappings: z.array(z.object({ projectId: id, family: id, originalId: nonnegativeInteger.max(MAX_NATIVE_INTEGER), effectiveId: nonnegativeInteger.max(MAX_NATIVE_INTEGER) }).strict()).max(MAX_COLLECTION_LENGTH).optional(),
    baseline: z.object({ catalogId: id, catalogRevisionId: id }).strict(),
    layers: z.array(z.object({ catalogId: id, catalogRevisionId: id, enabled: z.boolean() }).strict()).max(MAX_MOD_LAYERS),
    links: z.array(z.object({ projectId: id.optional(), modelKey: id, targetEntityId: id.nullable() }).strict()).max(MAX_COLLECTION_LENGTH),
  }).strict().superRefine((value, context) => {
    try { assertModComposition(value as unknown as import('../domain/types').ModComposition) } catch (error) { context.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'Invalid mod composition' }) }
  }).optional(),
  createdAt: timestamp,
}).strict()

const quantity = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('exact'), value: nonnegativeInteger }).strict(),
  z.object({ kind: z.literal('atLeast'), value: positiveInteger }).strict(),
  z.object({ kind: z.literal('unknown') }).strict(),
])

const inventoryPosition = z.object({
  id,
  revision: nonnegativeInteger,
  ref: entityRef,
  observedName: shortText.optional(),
  possession: z.enum(['owned', 'notOwned', 'unknown']),
  quantity,
  favorite: z.boolean(),
  protectedQuantity: nonnegativeInteger,
  wishlist: z.boolean(),
  note: longText.optional(),
  observedAt: dateOrTimestamp.optional(),
  sources: sourceRefs,
  updatedAt: timestamp,
}).strict()

const inventoryEvent = z.object({
  id,
  positionId: id.optional(),
  ref: entityRef,
  observedName: shortText.optional(),
  kind: z.enum(['acquired', 'lost']),
  quantity: knowledge(positiveInteger),
  observedAt: dateOrTimestamp.optional(),
  recordedAt: timestamp,
  sources: sourceRefs,
  note: longText.optional(),
}).strict()

const observedStat = z.object({ value: knowledge(finiteNumber), unit: nonemptyText }).strict()
const battleQuantity = z.number().int().min(0).max(MAX_NATIVE_INTEGER).nullable()
const battleResources = z.object({ hp: battleQuantity, mp: battleQuantity, ap: battleQuantity }).strict()
const battleStatuses = z.array(z.object({ ref: entityRef, count: z.number().int().min(1).max(MAX_NATIVE_INTEGER).nullable() }).strict()).max(MAX_COLLECTION_LENGTH)
const battleCalculation = z.object({
  version: z.literal(BATTLE_CALCULATION_VERSION),
  turnCount: battleQuantity,
  targetTurnCount: battleQuantity,
  automaticStatuses: z.boolean(),
  statuses: battleStatuses,
  user: battleResources,
  target: z.union([z.literal('self'), entityRef]).nullable(),
  targetResources: battleResources,
  targetStatuses: battleStatuses,
  repeatCount: battleQuantity,
  bottomThreat: z.boolean().nullable(),
  topThreat: z.boolean().nullable(),
  targetIsThreatTarget: z.boolean().nullable(),
  targetCharging: z.boolean().nullable(),
  previouslyAppliedStatuses: z.array(entityRef).max(MAX_COLLECTION_LENGTH),
  userPreviouslyAppliedStatuses: z.array(entityRef).max(MAX_COLLECTION_LENGTH),
}).strict().superRefine((battle, context) => {
  try { validateBattleCalculation(battle as unknown as BattleCalculationPlan, () => undefined) }
  catch (error) { context.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'Invalid battle calculation' }) }
})
const calculationPlan = z.object({
  model: z.literal('pc-1.6.9-v1').optional(),
  growthMode: z.enum(['primary', 'manual']).optional(),
  pcMode: z.enum(['standard', 'vanilla', 'chaos']).optional(),
  gender: z.enum(CALCULATION_GENDERS).optional(),
  genderSelection: z.object({ version: z.literal(GENDER_SELECTION_VERSION), id: z.number().int().min(0).max(MAX_GENDER_ID) }).strict().optional(),
  level: z.number().int().min(1).max(PC_LEVEL_CAP).nullable(),
  growth: z.array(z.object({ classRef: entityRef.nullable(), levels: z.number().int().min(0).max(PC_LEVEL_CAP).nullable() }).strict()).max(PC_LEVEL_CAP),
  bonuses: z.array(z.enum(STAT_KEYS)).max(STAT_KEYS.length).refine(values => new Set(values).size === values.length, 'Stat bonuses must be unique'),
  statuses: z.array(entityRef).max(MAX_COLLECTION_LENGTH),
  ability: entityRef.nullable().optional(),
  targetEvasion: finiteNumber.nonnegative().nullable().optional(),
  battle: battleCalculation.optional(),
}).strict().refine(plan => plan.gender === undefined || plan.genderSelection === undefined, 'Choose only one calculation gender')
const characterSnapshot = z.object({
  id,
  gameSetupRevisionId: id.optional(),
  observedAt: dateOrTimestamp.optional(),
  recordedAt: timestamp,
  level: knowledge(nonnegativeInteger),
  primaryClass: knowledge(entityRef),
  secondaryClass: knowledge(entityRef),
  displayedStats: z.record(z.string().min(1).max(MAX_ID_LENGTH), observedStat),
  equipment: z.record(id, entityRef.nullable()),
  passives: knowledge(z.array(entityRef).max(MAX_COLLECTION_LENGTH)),
  calculation: calculationPlan.optional(),
  sources: sourceRefs,
  note: longText.optional(),
}).strict()

const characterClassProgress = z.object({
  classRef: entityRef,
  unlocked: knowledge(z.boolean()),
  coreTreeComplete: knowledge(z.boolean()),
  mastered: knowledge(z.boolean()),
  observedLp: knowledge(nonnegativeInteger),
  sources: sourceRefs,
}).strict()

const learnedNode = z.object({
  ref: entityRef,
  kind: z.enum(['ability', 'passive', 'innate', 'monsterMagic']),
  learned: knowledge(z.boolean()),
  actualPaidLp: knowledge(nonnegativeInteger),
  sources: sourceRefs,
}).strict()

const character = z.object({
  id,
  revision: nonnegativeInteger,
  name: nonemptyText,
  appearanceLabel: shortText.optional(),
  currentSnapshotId: id.optional(),
  snapshots: z.record(id, characterSnapshot),
  classProgress: z.record(id, characterClassProgress),
  learnedNodes: z.record(id, learnedNode),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict()

const progressRecord = z.object({
  id,
  revision: nonnegativeInteger,
  subject: entityRef,
  displayName: nonemptyText,
  stage: knowledge(z.enum(['notAcquired', 'unlocked', 'mastered', 'sealAcquired'])),
  unlocked: knowledge(z.boolean()),
  partyMastery: knowledge(z.boolean()),
  collection: knowledge(z.boolean()),
  masterLocation: knowledge(shortText),
  sources: sourceRefs,
  observedAt: dateOrTimestamp.optional(),
  updatedAt: timestamp,
}).strict()

const buildSelection = z.object({ ref: entityRef, observedName: shortText.optional(), allocationId: id.optional() }).strict()
const buildRevisionContent = z.object({
  primaryClass: entityRef.nullable(),
  secondaryClass: entityRef.nullable(),
  equipment: z.record(id, buildSelection.nullable()),
  passives: z.array(buildSelection).max(MAX_COLLECTION_LENGTH),
  rotationNotes: longText.optional(),
  contextAssumptions: z.array(shortText).max(MAX_COLLECTION_LENGTH),
  calculation: calculationPlan.optional(),
  referenceNames: z.array(z.object({ ref: catalogRef, name: nonemptyText, projectId: id.optional(), modelKey: id.optional() }).strict()).max(MAX_COLLECTION_LENGTH).optional(),
}).strict()

const buildRevision = z.object({
  id,
  buildId: id,
  revision: nonnegativeInteger,
  parentRevisionId: id.optional(),
  gameSetupRevisionId: id,
  catalogLock,
  content: buildRevisionContent,
  note: longText.optional(),
  createdAt: timestamp,
}).strict()

const build = z.object({
  id,
  gameSetupId: id,
  revision: nonnegativeInteger,
  title: nonemptyText,
  archived: z.boolean(),
  tags: z.array(shortText).max(MAX_COLLECTION_LENGTH),
  favorite: z.boolean(),
  latestRevisionId: id.optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict()

const legacyBuild = build.omit({ archived: true }).extend({
  kind: z.enum(['build', 'template']),
  state: z.enum(['draft', 'hypothetical', 'archived']),
}).transform(({ kind: _kind, state, ...record }) => ({ ...record, archived: state === 'archived' }))

export const StoredBuildSchema = z.union([build, legacyBuild])

const scenarioBaseline = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('empty') }).strict(),
  z.object({
    kind: z.literal('recordedParty'),
    playthroughRevision: nonnegativeInteger,
    assignments: z.record(id, id),
  }).strict(),
])

const scenario = z.object({
  id,
  revision: nonnegativeInteger,
  label: nonemptyText,
  kind: z.enum(['recordedCurrent', 'draft', 'hypothetical']),
  memberIds: z.array(id).length(TEAM_SIZE),
  baseline: scenarioBaseline,
  assignments: z.record(id, id.nullable()),
  gameSetupRevisionId: id,
  catalogLock,
  inventoryPolicy: z.object({ includeProtected: z.boolean(), enforceStock: z.boolean() }).strict(),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict()

const goalRequirement = z.object({
  id,
  kind: z.enum(['acquire', 'learn', 'verify', 'configure']),
  target: entityRef.optional(),
  quantity: quantity.optional(),
  note: longText.optional(),
  state: knowledge(z.boolean()),
}).strict()

const goal = z.object({
  id,
  revision: nonnegativeInteger,
  title: nonemptyText,
  status: z.enum(['open', 'complete', 'dismissed']),
  priority: finiteNumber,
  requirements: z.array(goalRequirement).max(MAX_COLLECTION_LENGTH),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict()

const importReceipt = z.object({
  id,
  sourceFormat: nonemptyText,
  sourceIdentity: nonemptyText,
  importedAt: timestamp,
  localDataRevision: nonnegativeInteger,
}).strict()

const changeEntry = z.object({
  id,
  command: nonemptyText,
  previousRevision: nonnegativeInteger,
  nextRevision: nonnegativeInteger,
  changedPaths: z.array(nonemptyText).max(MAX_COLLECTION_LENGTH),
  recordedAt: timestamp,
}).strict()

const skillPosition = { row: z.number().int().min(0).max(5), column: z.number().int().min(0).max(3) }
const skillMapping = z.object({ ...skillPosition, ref: entityRef, kind: z.enum(['ability', 'passive', 'innate', 'monsterMagic']) }).strict()
const skillSquare = z.object({ ...skillPosition, state: z.enum(['learned', 'available', 'locked', 'unknown']) }).strict()
const skillLayout = z.object({ id, classRef: entityRef, gameSetupRevisionId: id.optional(), shape: shortText, mappings: z.array(skillMapping).max(24) }).strict()
const skillCapture = z.object({ id, characterId: id, classRef: entityRef, gameSetupRevisionId: id.optional(), sourceDigest: z.string().regex(/^[a-f0-9]{64}$/), filename: shortText.regex(/^[^/\\]+$/), recordedAt: timestamp, squares: z.array(skillSquare).min(1).max(24), mappings: z.array(skillMapping).max(24) }).strict()

const playthrough = z.object({
  id,
  revision: nonnegativeInteger,
  label: nonemptyText,
  createdAt: timestamp,
  updatedAt: timestamp,
  currentGameSetupRevisionId: id.optional(),
  activeScenarioId: id.optional(),
  inventory: z.record(id, inventoryPosition),
  inventoryEvents: z.record(id, inventoryEvent),
  characters: z.record(id, character),
  progress: z.record(id, progressRecord),
  quintarBreeding: z.record(id.refine(value => QUINTAR_BREEDING_STEP_IDS.has(value), 'Unknown quintar guide step'), timestamp).optional(),
  scenarios: z.record(id, scenario),
  goals: z.record(id, goal),
  skillTreeCaptures: z.record(id, skillCapture).optional(),
}).strict()

export const NativeLocalDataSchema = z.object({
  schemaVersion: z.literal(LOCAL_DATA_SCHEMA_VERSION),
  id,
  revision: nonnegativeInteger,
  createdAt: timestamp,
  updatedAt: timestamp,
  selectedPlaythroughId: id.optional(),
  planningGameSetupRevisionId: id.optional(),
  personalDefinitions: z.record(id, personalDefinition),
  gameSetups: z.record(id, gameSetupRevision),
  builds: z.record(id, build),
  buildRevisions: z.record(id, buildRevision),
  teams: z.record(id, z.object({ id, revision: nonnegativeInteger, title: nonemptyText, slots: z.array(id.nullable()).length(4), createdAt: timestamp, updatedAt: timestamp }).strict()),
  playthroughs: z.record(id, playthrough),
  importReceipts: z.record(id, importReceipt),
  changes: z.array(changeEntry).max(500),
  skillTreeLayouts: z.record(id, skillLayout).optional(),
  referenceLibrary: z.object({ version: z.literal(REFERENCE_LIBRARY_SETTINGS_VERSION), excludedMods: z.array(id).max(MAX_COLLECTION_LENGTH).refine(values => new Set(values).size === values.length, 'Mod identities must be unique') }).strict().optional(),
  modSetup: z.object({ version: z.literal(1), state: z.enum(['pending', 'skipped', 'completed']) }).strict().optional(),
}).strict()

const PreviousBuildRevisionSchema = buildRevision.extend({ content: buildRevisionContent.omit({ referenceNames: true }) })
export const PreviousLocalDataSchema = NativeLocalDataSchema.extend({ schemaVersion: z.literal('2.3.0'), buildRevisions: z.record(id, PreviousBuildRevisionSchema), gameSetups: z.record(id, gameSetupRevision.omit({ modSourceReceipts: true })) })
const ClassifiedNativeLocalDataSchema = PreviousLocalDataSchema.extend({ schemaVersion: z.literal('2.2.0'), builds: z.record(id, StoredBuildSchema) })
const PreviousNativeLocalDataSchema = ClassifiedNativeLocalDataSchema.omit({ teams: true }).extend({ schemaVersion: z.literal('2.1.0') })

export const LegacyNativeLocalDataSchema = PreviousNativeLocalDataSchema.extend({
  schemaVersion: z.literal('2.0.0'),
  gameSetups: z.record(id, gameSetupRevision.omit({ customMods: true, modSourceReceipts: true })),
}).superRefine((data, context) => {
  for (const revision of Object.values(data.buildRevisions)) {
    if (data.gameSetups[revision.gameSetupRevisionId]?.gameSetupId !== data.builds[revision.buildId]?.gameSetupId) context.addIssue({ code: 'custom', message: 'A legacy checkpoint has inconsistent Game Setup ownership' })
  }
})

export const StoredNativeLocalDataSchema = z.union([NativeLocalDataSchema, PreviousLocalDataSchema, ClassifiedNativeLocalDataSchema, PreviousNativeLocalDataSchema, LegacyNativeLocalDataSchema]).transform(data => {
  return { ...data, schemaVersion: LOCAL_DATA_SCHEMA_VERSION, teams: 'teams' in data ? data.teams : {} }
})

export const NativeLineageSchema = z.object({
  rootLocalDataId: id,
  parentLocalDataId: id.optional(),
  sourceLocalDataId: id.optional(),
  sourceRevision: nonnegativeInteger.optional(),
  forkedAt: timestamp.optional(),
}).strict()

export const NativeEvidenceSchema = z.object({
  id,
  sourceDigest: z.string().regex(/^[0-9a-f]{64}$/),
  group: z.enum(['reference', 'personal', 'mixed', 'ignored']),
  kind: nonemptyText,
  locator: shortText,
  sources: sourceRefs,
  payload: jsonValue,
  private: z.boolean(),
}).strict()

export const NativeHistorySchema = z.object({
  id,
  localDataId: id,
  command: nonemptyText,
  previousRevision: nonnegativeInteger,
  nextRevision: nonnegativeInteger,
  before: StoredNativeLocalDataSchema,
  after: StoredNativeLocalDataSchema,
  recordedAt: timestamp,
}).strict()

export const ImportFormatSchema = z.enum([
  'research-json-1.1.0',
  'research-zip-1.1.0',
  'xlsx-v2',
  'native-backup-2.0.0',
  'native-backup-2.1.0',
  'crystal-edit-json-1',
])

export const NativeSourceManifestSchema = z.object({
  id,
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  filename: nonemptyText,
  mediaType: nonemptyText,
  format: ImportFormatSchema,
  importedAt: timestamp,
  path: z.string().regex(/^sources\/[0-9]{4}\.bin$/),
  size: nonnegativeInteger,
}).strict()

export const NATIVE_BACKUP_FORMAT_VERSION = '2.1.0'
export const NativeManifestSchema = z.object({
  format: z.literal('crykit-backup'),
  formatVersion: z.enum(['2.0.0', NATIVE_BACKUP_FORMAT_VERSION]),
  exportedAt: timestamp,
  payload: z.literal('bundle.json'),
  sources: z.array(NativeSourceManifestSchema).max(510),
  history: z.object({
    stored: nonnegativeInteger,
    exported: nonnegativeInteger,
    truncated: z.boolean(),
  }).strict().optional(),
}).strict()

export const NativePayloadSchema = z.object({
  localData: StoredNativeLocalDataSchema,
  lineage: NativeLineageSchema,
  catalogs: z.array(NativeCatalogSnapshotSchema).max(MAX_COLLECTION_LENGTH),
  bundledCatalogs: z.array(z.object({ id, revisionId: id, checksum: nonemptyText }).strict()).max(MAX_COLLECTION_LENGTH).optional(),
  evidence: z.array(NativeEvidenceSchema).max(MAX_COLLECTION_LENGTH),
  history: z.array(NativeHistorySchema).max(500),
}).strict()
