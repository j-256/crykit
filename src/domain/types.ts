export type Brand<Value, Name extends string> = Value & { readonly __brand: Name }

export type ProfileId = Brand<string, 'ProfileId'>
export type PersonalDefinitionId = Brand<string, 'PersonalDefinitionId'>
export type CatalogId = Brand<string, 'CatalogId'>
export type CatalogRevisionId = Brand<string, 'CatalogRevisionId'>
export type EntityId = Brand<string, 'EntityId'>
export type InventoryPositionId = Brand<string, 'InventoryPositionId'>
export type InventoryEventId = Brand<string, 'InventoryEventId'>
export type CharacterId = Brand<string, 'CharacterId'>
export type CharacterSnapshotId = Brand<string, 'CharacterSnapshotId'>
export type ProgressRecordId = Brand<string, 'ProgressRecordId'>
export type BuildId = Brand<string, 'BuildId'>
export type BuildRevisionId = Brand<string, 'BuildRevisionId'>
export type ScenarioId = Brand<string, 'ScenarioId'>
export type RulesetId = Brand<string, 'RulesetId'>
export type RulesetRevisionId = Brand<string, 'RulesetRevisionId'>
export type GoalId = Brand<string, 'GoalId'>
export type ChangeId = Brand<string, 'ChangeId'>
export type ImportReceiptId = Brand<string, 'ImportReceiptId'>
export type SlotId = Brand<string, 'SlotId'>
export type Timestamp = Brand<string, 'Timestamp'>

export type DomainId =
  | ProfileId
  | PersonalDefinitionId
  | CatalogId
  | CatalogRevisionId
  | EntityId
  | InventoryPositionId
  | InventoryEventId
  | CharacterId
  | CharacterSnapshotId
  | ProgressRecordId
  | BuildId
  | BuildRevisionId
  | ScenarioId
  | RulesetId
  | RulesetRevisionId
  | GoalId
  | ChangeId
  | ImportReceiptId
  | SlotId

export type JsonPrimitive = boolean | number | string | null
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue }

export interface SourceRef {
  readonly sourceId: string
  readonly locator?: string
  readonly snapshot?: string
  readonly applicability?: string
  readonly checkedAt?: Timestamp
}

export interface KnowledgeClaim<Value> {
  readonly value: Value
  readonly sources: readonly SourceRef[]
  readonly note?: string
}

export type Knowledge<Value> =
  | { readonly state: 'known'; readonly value: Value; readonly sources?: readonly SourceRef[] }
  | { readonly state: 'unknown'; readonly reason?: string; readonly sources?: readonly SourceRef[] }
  | { readonly state: 'conflicting'; readonly claims: readonly KnowledgeClaim<Value>[] }
  | { readonly state: 'notApplicable'; readonly reason?: string }

export type Quantity =
  | { readonly kind: 'exact'; readonly value: number }
  | { readonly kind: 'atLeast'; readonly value: number }
  | { readonly kind: 'unknown' }

export type PossessionState = 'owned' | 'notOwned' | 'unknown'

export type CatalogEntityKind =
  | 'item'
  | 'class'
  | 'ability'
  | 'passive'
  | 'innate'
  | 'monsterMagic'
  | 'monster'
  | 'command'
  | 'status'
  | 'recipe'
  | 'location'
  | 'other'

export interface CatalogRef {
  readonly kind: 'catalog'
  readonly catalogId: CatalogId
  readonly catalogRevisionId: CatalogRevisionId
  readonly entityId: EntityId
}

export interface PersonalRef {
  readonly kind: 'personal'
  readonly definitionId: PersonalDefinitionId
}

export type EntityRef = CatalogRef | PersonalRef

export interface NumericContribution {
  readonly value: number
  readonly unit: string
  readonly condition?: string
}

export type EntityRequirement =
  | { readonly kind: 'permission'; readonly permission: string }
  | { readonly kind: 'selected'; readonly ref: EntityRef }

export interface CatalogEntity {
  readonly id: EntityId
  readonly kind: CatalogEntityKind
  readonly name: string
  readonly aliases: readonly string[]
  readonly fields: Readonly<Record<string, Knowledge<JsonValue>>>
  readonly rawDescription?: string
  readonly slotKinds?: Knowledge<readonly string[]>
  readonly occupiesSlots?: Knowledge<number>
  readonly ppCost?: Knowledge<number>
  readonly listedContributions?: Readonly<Record<string, Knowledge<NumericContribution>>>
  readonly requirements?: Knowledge<readonly EntityRequirement[]>
  readonly grants?: Knowledge<readonly string[]>
  readonly sources: readonly SourceRef[]
  readonly legacy?: JsonValue
}

export interface CatalogClaim {
  readonly entityId: EntityId
  readonly field: string
  readonly value: Knowledge<JsonValue>
  readonly sources: readonly SourceRef[]
}

export interface CatalogSnapshot {
  readonly id: CatalogId
  readonly revisionId: CatalogRevisionId
  readonly schemaVersion: string
  readonly checksum: string
  readonly importedAt: Timestamp
  readonly applicability: Knowledge<string>
  readonly rights: Knowledge<string>
  readonly entities: Readonly<Record<string, CatalogEntity>>
  readonly claims: readonly CatalogClaim[]
  readonly legacy?: JsonValue
}

export interface PersonalDefinition {
  readonly id: PersonalDefinitionId
  readonly revision: number
  readonly baseRef?: EntityRef
  readonly previousRevision?: PersonalRef
  readonly kind: CatalogEntityKind
  readonly name: string
  readonly aliases: readonly string[]
  readonly rawDescription?: string
  readonly fields: Readonly<Record<string, Knowledge<JsonValue>>>
  readonly slotKinds?: Knowledge<readonly string[]>
  readonly occupiesSlots?: Knowledge<number>
  readonly ppCost?: Knowledge<number>
  readonly listedContributions?: Readonly<Record<string, Knowledge<NumericContribution>>>
  readonly requirements?: Knowledge<readonly EntityRequirement[]>
  readonly grants?: Knowledge<readonly string[]>
  readonly sources: readonly SourceRef[]
  readonly createdAt: Timestamp
  readonly updatedAt: Timestamp
}

export type SlotKind = 'equipment'
export type SlotProvenance = 'verified' | 'imported' | 'suggested' | 'userDefined'
export type EquipmentRole = 'mainHand' | 'offHand' | 'head' | 'body' | 'accessory'

export interface SlotDefinition {
  readonly id: SlotId
  readonly kind: SlotKind
  readonly label: string
  readonly order: number
  readonly equipmentRole?: EquipmentRole | null
  readonly acceptedEntityKinds?: Knowledge<readonly CatalogEntityKind[]>
  readonly provenance: SlotProvenance
  readonly sources: readonly SourceRef[]
}

export interface RulesetRevision {
  readonly id: RulesetRevisionId
  readonly rulesetId: RulesetId
  readonly revision: number
  readonly label: string
  readonly platform: Knowledge<string>
  readonly gameVersion: Knowledge<string>
  readonly mode: Knowledge<string>
  readonly mods: Knowledge<readonly string[]>
  readonly disabledMods?: Knowledge<readonly string[]>
  readonly ppLimit?: Knowledge<number>
  readonly ppCostsNonNegative: Knowledge<boolean>
  readonly slots: readonly SlotDefinition[]
  readonly catalogLock: Readonly<Record<string, CatalogRevisionId>>
  readonly definitionOverrides?: readonly PersonalRef[]
  readonly createdAt: Timestamp
}

export interface InventoryPosition {
  readonly id: InventoryPositionId
  readonly revision: number
  readonly ref: EntityRef
  readonly observedName?: string
  readonly possession: PossessionState
  readonly quantity: Quantity
  readonly favorite: boolean
  readonly protectedQuantity: number
  readonly wishlist: boolean
  readonly note?: string
  readonly observedAt?: Timestamp
  readonly sources: readonly SourceRef[]
  readonly updatedAt: Timestamp
}

export type InventoryEventKind = 'acquired' | 'lost'

export interface InventoryEvent {
  readonly id: InventoryEventId
  readonly positionId?: InventoryPositionId
  readonly ref: EntityRef
  readonly observedName?: string
  readonly kind: InventoryEventKind
  readonly quantity: Knowledge<number>
  readonly observedAt?: Timestamp
  readonly recordedAt: Timestamp
  readonly sources: readonly SourceRef[]
  readonly note?: string
}

export interface ObservedStat {
  readonly value: Knowledge<number>
  readonly unit: string
}

export interface CharacterSnapshot {
  readonly id: CharacterSnapshotId
  readonly rulesetRevisionId?: RulesetRevisionId
  readonly observedAt?: Timestamp
  readonly recordedAt: Timestamp
  readonly level: Knowledge<number>
  readonly primaryClass: Knowledge<EntityRef>
  readonly secondaryClass: Knowledge<EntityRef>
  readonly displayedStats: Readonly<Record<string, ObservedStat>>
  readonly ppCapacity: Knowledge<number>
  readonly equipment: Readonly<Record<string, EntityRef | null>>
  readonly passives: Knowledge<readonly EntityRef[]>
  readonly sources: readonly SourceRef[]
  readonly note?: string
}

export interface CharacterClassProgress {
  readonly classRef: EntityRef
  readonly unlocked: Knowledge<boolean>
  readonly coreTreeComplete: Knowledge<boolean>
  readonly mastered: Knowledge<boolean>
  readonly observedLp: Knowledge<number>
  readonly sources: readonly SourceRef[]
}

export type LearnedNodeKind = 'ability' | 'passive' | 'innate' | 'monsterMagic'

export interface LearnedNode {
  readonly ref: EntityRef
  readonly kind: LearnedNodeKind
  readonly learned: Knowledge<boolean>
  readonly actualPaidLp: Knowledge<number>
  readonly sources: readonly SourceRef[]
}

export type SkillSquareState = 'learned' | 'available' | 'locked' | 'unknown'

export interface SkillSquare {
  readonly row: number
  readonly column: number
  readonly state: SkillSquareState
}

export interface SkillTreeMapping {
  readonly row: number
  readonly column: number
  readonly ref: EntityRef
  readonly kind: LearnedNodeKind
}

export interface SkillTreeLayout {
  readonly id: string
  readonly classRef: EntityRef
  readonly rulesetRevisionId?: RulesetRevisionId
  readonly shape: string
  readonly mappings: readonly SkillTreeMapping[]
}

export interface SkillTreeCapture {
  readonly id: string
  readonly characterId: CharacterId
  readonly classRef: EntityRef
  readonly rulesetRevisionId?: RulesetRevisionId
  readonly sourceDigest: string
  readonly filename: string
  readonly recordedAt: Timestamp
  readonly squares: readonly SkillSquare[]
  readonly mappings: readonly SkillTreeMapping[]
}

export interface Character {
  readonly id: CharacterId
  readonly revision: number
  readonly name: string
  readonly appearanceLabel?: string
  readonly currentSnapshotId?: CharacterSnapshotId
  readonly snapshots: Readonly<Record<string, CharacterSnapshot>>
  readonly classProgress: Readonly<Record<string, CharacterClassProgress>>
  readonly learnedNodes: Readonly<Record<string, LearnedNode>>
  readonly createdAt: Timestamp
  readonly updatedAt: Timestamp
}

export type ProgressStage = 'collected' | 'masteredPending' | 'inProgress' | 'unclassified'

export interface PartyProgressRecord {
  readonly id: ProgressRecordId
  readonly revision: number
  readonly subject: EntityRef
  readonly displayName: string
  readonly stage: Knowledge<ProgressStage>
  readonly unlocked: Knowledge<boolean>
  readonly partyMastery: Knowledge<boolean>
  readonly collection: Knowledge<boolean>
  readonly masterLocation: Knowledge<string>
  readonly sources: readonly SourceRef[]
  readonly observedAt?: Timestamp
  readonly updatedAt: Timestamp
}

export type BuildKind = 'character' | 'template'
export type BuildState = 'recordedCurrent' | 'draft' | 'hypothetical' | 'archived'

export interface BuildSelection {
  readonly ref: EntityRef
  readonly observedName?: string
  readonly allocationId?: string
}

export interface BuildRevisionContent {
  readonly primaryClass: EntityRef | null
  readonly secondaryClass: EntityRef | null
  readonly equipment: Readonly<Record<string, BuildSelection | null>>
  readonly passives: readonly BuildSelection[]
  readonly rotationNotes?: string
  readonly contextAssumptions: readonly string[]
  readonly calculation?: BuildCalculationPlan
}

export interface BuildCalculationPlan {
  readonly level: number | null
  readonly growth: readonly { readonly classRef: EntityRef | null; readonly levels: number | null }[]
  readonly bonuses: readonly import('./crystal-edit').GrowthStat[]
  readonly statuses: readonly EntityRef[]
  readonly ability?: EntityRef | null
  readonly targetEvasion?: number | null
}

export interface BuildRevision {
  readonly id: BuildRevisionId
  readonly buildId: BuildId
  readonly revision: number
  readonly parentRevisionId?: BuildRevisionId
  readonly rulesetRevisionId: RulesetRevisionId
  readonly catalogLock: Readonly<Record<string, CatalogRevisionId>>
  readonly content: BuildRevisionContent
  readonly note?: string
  readonly createdAt: Timestamp
}

export interface Build {
  readonly id: BuildId
  readonly revision: number
  readonly title: string
  readonly kind: BuildKind
  readonly characterId?: CharacterId
  readonly state: BuildState
  readonly tags: readonly string[]
  readonly favorite: boolean
  readonly latestRevisionId?: BuildRevisionId
  readonly createdAt: Timestamp
  readonly updatedAt: Timestamp
}

export type ScenarioKind = 'recordedCurrent' | 'draft' | 'hypothetical'

export interface InventoryPolicy {
  readonly includeProtected: boolean
  readonly enforceStock: boolean
}

export type ScenarioBaseline =
  | { readonly kind: 'empty' }
  | {
      readonly kind: 'recordedParty'
      readonly profileRevision: number
      readonly assignments: Readonly<Record<string, BuildRevisionId>>
    }

export interface TeamScenario {
  readonly id: ScenarioId
  readonly revision: number
  readonly label: string
  readonly kind: ScenarioKind
  readonly memberIds: readonly CharacterId[]
  readonly baseline: ScenarioBaseline
  readonly assignments: Readonly<Record<string, BuildRevisionId | null>>
  readonly rulesetRevisionId: RulesetRevisionId
  readonly catalogLock: Readonly<Record<string, CatalogRevisionId>>
  readonly inventoryPolicy: InventoryPolicy
  readonly createdAt: Timestamp
  readonly updatedAt: Timestamp
}

export type GoalStatus = 'open' | 'complete' | 'dismissed'
export type GoalRequirementKind = 'acquire' | 'learn' | 'verify' | 'configure'

export interface GoalRequirement {
  readonly id: string
  readonly kind: GoalRequirementKind
  readonly target?: EntityRef
  readonly quantity?: Quantity
  readonly note?: string
  readonly state: Knowledge<boolean>
}

export interface Goal {
  readonly id: GoalId
  readonly revision: number
  readonly title: string
  readonly status: GoalStatus
  readonly priority: number
  readonly requirements: readonly GoalRequirement[]
  readonly createdAt: Timestamp
  readonly updatedAt: Timestamp
}

export interface ImportReceipt {
  readonly id: ImportReceiptId
  readonly sourceFormat: string
  readonly sourceIdentity: string
  readonly importedAt: Timestamp
  readonly profileRevision: number
}

export interface ChangeEntry {
  readonly id: ChangeId
  readonly command: string
  readonly previousRevision: number
  readonly nextRevision: number
  readonly changedPaths: readonly string[]
  readonly recordedAt: Timestamp
}

export interface Profile {
  readonly schemaVersion: '1.0.0'
  readonly id: ProfileId
  readonly revision: number
  readonly label: string
  readonly createdAt: Timestamp
  readonly updatedAt: Timestamp
  readonly activeRulesetRevisionId?: RulesetRevisionId
  readonly activeScenarioId?: ScenarioId
  readonly personalDefinitions: Readonly<Record<string, PersonalDefinition>>
  readonly rulesets: Readonly<Record<string, RulesetRevision>>
  readonly inventory: Readonly<Record<string, InventoryPosition>>
  readonly inventoryEvents: Readonly<Record<string, InventoryEvent>>
  readonly characters: Readonly<Record<string, Character>>
  readonly progress: Readonly<Record<string, PartyProgressRecord>>
  readonly builds: Readonly<Record<string, Build>>
  readonly buildRevisions: Readonly<Record<string, BuildRevision>>
  readonly scenarios: Readonly<Record<string, TeamScenario>>
  readonly goals: Readonly<Record<string, Goal>>
  readonly importReceipts: Readonly<Record<string, ImportReceipt>>
  readonly changes: readonly ChangeEntry[]
  readonly skillTreeLayouts?: Readonly<Record<string, SkillTreeLayout>>
  readonly skillTreeCaptures?: Readonly<Record<string, SkillTreeCapture>>
}

export type TruthValue = 'true' | 'false' | 'unknown'
export type QueryScalar = boolean | number | string | null
export type QueryValue = Knowledge<QueryScalar | readonly QueryScalar[]>
export type QueryRecord = Readonly<Record<string, QueryValue | undefined>>

export type QueryOperator = 'eq' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'exists'

export type QueryNode =
  | { readonly kind: 'predicate'; readonly field: string; readonly operator: QueryOperator; readonly value?: QueryScalar | readonly QueryScalar[] }
  | { readonly kind: 'and'; readonly children: readonly QueryNode[] }
  | { readonly kind: 'or'; readonly children: readonly QueryNode[] }
  | { readonly kind: 'not'; readonly child: QueryNode }

export interface CatalogIndex {
  readonly snapshots: Readonly<Record<string, CatalogSnapshot>>
  readonly entitiesByRef: Readonly<Record<string, CatalogEntity>>
}

export type ValidationDimension =
  | 'structure'
  | 'equipment'
  | 'passives'
  | 'characterReadiness'
  | 'inventory'
  | 'rulesetCertainty'
  | 'calculationReadiness'

export type ValidationStatus = 'valid' | 'invalid' | 'undetermined' | 'notApplicable'

export interface ValidationIssue {
  readonly code: string
  readonly dimension: ValidationDimension
  readonly status: 'invalid' | 'undetermined'
  readonly message: string
  readonly characterId?: CharacterId
  readonly buildRevisionId?: BuildRevisionId
  readonly slotId?: SlotId
  readonly ref?: EntityRef
  readonly ruleId?: string
  readonly inputs?: JsonValue
  readonly sources?: readonly SourceRef[]
  readonly suggestion?: string
}

export interface ValidationDimensionResult {
  readonly status: ValidationStatus
  readonly issues: readonly ValidationIssue[]
}

export interface ValidationReport {
  readonly scenarioId: ScenarioId
  readonly profileRevision: number
  readonly rulesetRevisionId: RulesetRevisionId
  readonly dimensions: Readonly<Record<ValidationDimension, ValidationDimensionResult>>
  readonly issues: readonly ValidationIssue[]
}

export interface DescriptiveDifference {
  readonly path: string
  readonly label: string
  readonly left: JsonValue | undefined
  readonly right: JsonValue | undefined
}

export interface BuildComparison {
  readonly leftRevisionId: BuildRevisionId
  readonly rightRevisionId: BuildRevisionId
  readonly differences: readonly DescriptiveDifference[]
}
