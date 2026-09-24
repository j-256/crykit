import { z } from 'zod'
import { asTimestamp } from '../domain/core'
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
  occupiesSlots: knowledge(positiveInteger).optional(),
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
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict()

const slotDefinition = z.object({
  id,
  kind: z.enum(['equipment', 'passive']),
  label: nonemptyText,
  order: safeInteger,
  acceptedEntityKinds: knowledge(z.array(catalogEntityKind).max(MAX_COLLECTION_LENGTH)).optional(),
  provenance: z.enum(['verified', 'imported', 'suggested', 'userDefined']),
  sources: sourceRefs,
}).strict()

const catalogLock = z.record(id, id)
const rulesetRevision = z.object({
  id,
  rulesetId: id,
  revision: nonnegativeInteger,
  label: nonemptyText,
  platform: knowledge(shortText),
  gameVersion: knowledge(shortText),
  mode: knowledge(shortText),
  mods: knowledge(z.array(shortText).max(MAX_COLLECTION_LENGTH)),
  ppCostsNonNegative: knowledge(z.boolean()),
  slots: z.array(slotDefinition).max(MAX_COLLECTION_LENGTH),
  catalogLock,
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
const characterSnapshot = z.object({
  id,
  observedAt: dateOrTimestamp.optional(),
  recordedAt: timestamp,
  level: knowledge(nonnegativeInteger),
  primaryClass: knowledge(entityRef),
  secondaryClass: knowledge(entityRef),
  displayedStats: z.record(z.string().min(1).max(MAX_ID_LENGTH), observedStat),
  ppCapacity: knowledge(nonnegativeInteger),
  selections: z.record(id, entityRef.nullable()),
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
  stage: knowledge(z.enum(['collected', 'masteredPending', 'inProgress', 'unclassified'])),
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
  selections: z.record(id, buildSelection.nullable()),
  rotationNotes: longText.optional(),
  contextAssumptions: z.array(shortText).max(MAX_COLLECTION_LENGTH),
}).strict()

const buildRevision = z.object({
  id,
  buildId: id,
  revision: nonnegativeInteger,
  parentRevisionId: id.optional(),
  rulesetRevisionId: id,
  catalogLock,
  content: buildRevisionContent,
  note: longText.optional(),
  createdAt: timestamp,
}).strict()

const build = z.object({
  id,
  revision: nonnegativeInteger,
  title: nonemptyText,
  kind: z.enum(['character', 'template']),
  characterId: id.optional(),
  state: z.enum(['recordedCurrent', 'draft', 'hypothetical', 'archived']),
  tags: z.array(shortText).max(MAX_COLLECTION_LENGTH),
  favorite: z.boolean(),
  latestRevisionId: id.optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict()

const scenarioBaseline = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('empty') }).strict(),
  z.object({
    kind: z.literal('recordedParty'),
    profileRevision: nonnegativeInteger,
    assignments: z.record(id, id),
  }).strict(),
])

const scenario = z.object({
  id,
  revision: nonnegativeInteger,
  label: nonemptyText,
  kind: z.enum(['recordedCurrent', 'draft', 'hypothetical']),
  baseline: scenarioBaseline,
  assignments: z.record(id, id.nullable()),
  rulesetRevisionId: id,
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
  profileRevision: nonnegativeInteger,
}).strict()

const changeEntry = z.object({
  id,
  command: nonemptyText,
  previousRevision: nonnegativeInteger,
  nextRevision: nonnegativeInteger,
  changedPaths: z.array(nonemptyText).max(MAX_COLLECTION_LENGTH),
  recordedAt: timestamp,
}).strict()

export const NativeProfileSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  id,
  revision: nonnegativeInteger,
  label: nonemptyText,
  createdAt: timestamp,
  updatedAt: timestamp,
  activeRulesetRevisionId: id.optional(),
  activeScenarioId: id.optional(),
  personalDefinitions: z.record(id, personalDefinition),
  rulesets: z.record(id, rulesetRevision),
  inventory: z.record(id, inventoryPosition),
  inventoryEvents: z.record(id, inventoryEvent),
  characters: z.record(id, character),
  progress: z.record(id, progressRecord),
  builds: z.record(id, build),
  buildRevisions: z.record(id, buildRevision),
  scenarios: z.record(id, scenario),
  goals: z.record(id, goal),
  importReceipts: z.record(id, importReceipt),
  changes: z.array(changeEntry).max(500),
}).strict()

export const NativeLineageSchema = z.object({
  rootProfileId: id,
  parentProfileId: id.optional(),
  sourceProfileId: id.optional(),
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
  profileId: id,
  command: nonemptyText,
  previousRevision: nonnegativeInteger,
  nextRevision: nonnegativeInteger,
  before: NativeProfileSchema,
  after: NativeProfileSchema,
  recordedAt: timestamp,
}).strict()

export const ImportFormatSchema = z.enum([
  'research-json-1.1.0',
  'research-zip-1.1.0',
  'xlsx-v2',
  'native-backup-1.0.0',
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

export const NativeManifestSchema = z.object({
  format: z.literal('crystal-companion-backup'),
  formatVersion: z.literal('1.0.0'),
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
  profile: NativeProfileSchema,
  lineage: NativeLineageSchema,
  catalogs: z.array(NativeCatalogSnapshotSchema).max(MAX_COLLECTION_LENGTH),
  evidence: z.array(NativeEvidenceSchema).max(MAX_COLLECTION_LENGTH),
  history: z.array(NativeHistorySchema).max(500),
}).strict()
