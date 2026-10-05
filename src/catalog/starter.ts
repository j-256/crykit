import type {
  CatalogEntity,
  CatalogEntityKind,
  CatalogId,
  CatalogRevisionId,
  CatalogSnapshot,
  EntityId,
  JsonValue,
  Knowledge,
  NumericContribution,
  SourceRef,
  Timestamp,
} from '../domain/types'
import {
  STARTER_CATALOG_CONTENT_DIGEST,
  STARTER_NAME_RECORDS,
  STARTER_SOURCE_URLS,
} from './data'
import wikiDataJson from './wiki-data.json' with { type: 'json' }
import { confirmedSwitchDefinitions, SWITCH_CLASS_SOURCE } from './switch'

export const STARTER_CATALOG_ID = 'crystal-project-public-starter' as CatalogId
export const STARTER_CATALOG_REVISION_ID = 'catalog-v1' as CatalogRevisionId

const SOURCE_APPLICABILITY = 'Name evidence only; platform and enabled-mod applicability are unverified'
const WIKI_GAP_REASON = 'No matching detail page or structured row was found in the bundled community wiki snapshot'
const SLOT_UNKNOWN_REASON = "The wiki does not map this definition to this Game Setup's slot IDs"
const REQUIREMENTS_UNKNOWN_REASON = 'The wiki description is preserved, but its requirements are not normalized to exact catalog references or permissions'
const GRANTS_UNKNOWN_REASON = 'The wiki description is preserved, but its granted permissions are not normalized for validation'
const PP_UNKNOWN_REASON = 'The scraped wiki fields do not document a numeric PP cost'
const MOD_PACK_2_SOURCE: SourceRef = {
  sourceId: STARTER_SOURCE_URLS['nintendo-mod-pack-2'],
  locator: 'Publisher-provided Mod Pack 2 description',
  applicability: 'Nintendo Switch Mod Pack 2 high-level contents only',
}
const MOD_PACK_1_SOURCE: SourceRef = {
  sourceId: STARTER_SOURCE_URLS['nintendo-mod-pack-1'],
  locator: 'Publisher-provided Mod Pack 1 description',
  applicability: 'Nintendo Switch Mod Pack 1 high-level contents only',
}
const MOD_PACK_2_CLASS_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
  Bloodmage: 'Magical class focused on Mind that can use HP for buffs and debuffs.',
  Tempest: 'Physical class focused on Agility and Mind.',
  Forcemage: 'Spirit-focused magic class capable of tanking, support, or damage.',
  Barbarian: 'Vitality and high-HP physical class capable of tanking, support, or damage.',
})

interface WikiCatalogData {
  readonly contentDigest: string
  readonly maxRevision: string
  readonly source: {
    readonly name: string
    readonly rights: string
    readonly rightsUrl: string
  }
  readonly entities: readonly CatalogEntity[]
  readonly coverage: {
    readonly redlinks: readonly string[]
    readonly issues: readonly JsonValue[]
    readonly unimportedPages: readonly string[]
  }
}

const WIKI_DATA = wikiDataJson as unknown as WikiCatalogData
const NUMERIC_CONTRIBUTION_FIELDS = new Set([
  'Accuracy',
  'Agility',
  'Attack',
  'Crit. Chance',
  'Crit. Damage',
  'Def. Pierce',
  'Defense',
  'Dexterity',
  'Evasion',
  'Luck',
  'Max. HP',
  'Max. MP',
  'Mind',
  'Res. Pierce',
  'Resistance',
  'Speed',
  'Spirit',
  'Strength',
  'Vitality',
])

function deepFreeze<Value>(value: Value): Value {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

function normalizedIdentity(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim()
}

function entityIdentity(kind: CatalogEntityKind, name: string): string {
  return `${kind}\u0000${normalizedIdentity(name)}`
}

function uniqueSources(sources: readonly SourceRef[]): readonly SourceRef[] {
  return Array.from(new Map(sources.map((source) => [JSON.stringify(source), source])).values())
}

function known<Value>(value: Value, sources?: readonly SourceRef[]): Knowledge<Value> {
  return { state: 'known', value, ...(sources?.length ? { sources } : {}) }
}

function unknown<Value>(reason: string, sources?: readonly SourceRef[]): Knowledge<Value> {
  return { state: 'unknown', reason, ...(sources?.length ? { sources } : {}) }
}

function notApplicable<Value>(reason: string): Knowledge<Value> {
  return { state: 'notApplicable', reason }
}

function sourceForRecord(record: typeof STARTER_NAME_RECORDS[number]): SourceRef {
  return {
    sourceId: STARTER_SOURCE_URLS[record[3]],
    locator: record[2],
    applicability: SOURCE_APPLICABILITY,
  }
}

function namesOnlyEntity(record: typeof STARTER_NAME_RECORDS[number]): CatalogEntity {
  const [id, kind, name] = record
  const source = sourceForRecord(record)
  const officialDescription = kind === 'class' ? MOD_PACK_2_CLASS_DESCRIPTIONS[name] : undefined
  const fields: Readonly<Record<string, Knowledge<JsonValue>>> = {
    'Wiki coverage': unknown(WIKI_GAP_REASON, [source]),
    ...(officialDescription ? {
      Category: known(['Mod Pack 2 class'], [MOD_PACK_2_SOURCE]),
      'Source mod': known(name, [MOD_PACK_2_SOURCE]),
      Description: known(officialDescription, [MOD_PACK_2_SOURCE]),
      'Missing wiki details': known(['Crystal', 'Master', 'Command', 'Innate passive(s)', 'Weapons', 'Armor', 'Initial equipment', 'Total LP to master', 'Stat growth', 'Abilities', 'Passives'], [MOD_PACK_2_SOURCE]),
    } : {}),
  }
  return applyPlanningKnowledge({
    id: id as EntityId,
    kind,
    name,
    aliases: [],
    fields,
    ...(officialDescription ? { rawDescription: officialDescription } : {}),
    sources: uniqueSources([source, ...(officialDescription ? [MOD_PACK_2_SOURCE] : [])]),
    legacy: { wiki: { missingDetailPageOrRow: true } },
  })
}

function knownNumber(field: Knowledge<JsonValue> | undefined): { readonly value: number; readonly sources?: readonly SourceRef[] } | undefined {
  return field?.state === 'known' && typeof field.value === 'number'
    ? { value: field.value, ...(field.sources ? { sources: field.sources } : {}) }
    : undefined
}

function listedContributions(entity: CatalogEntity): Readonly<Record<string, Knowledge<NumericContribution>>> | undefined {
  if (entity.kind !== 'item') return undefined
  const contributions = Object.fromEntries(Object.entries(entity.fields).flatMap(([name, field]) => {
    if (!NUMERIC_CONTRIBUTION_FIELDS.has(name)) return []
    const numeric = knownNumber(field)
    if (!numeric) return []
    return [[name, known({ value: numeric.value, unit: 'listed flat value' }, numeric.sources)]]
  }))
  return Object.keys(contributions).length > 0 ? contributions : undefined
}

function applyPlanningKnowledge(entity: CatalogEntity): CatalogEntity {
  const selectableEquipment = entity.kind === 'item'
  const selectablePassive = entity.kind === 'passive' || entity.kind === 'innate'
  const permissionBearing = selectableEquipment || selectablePassive || entity.kind === 'class'
  const contributions = listedContributions(entity)
  return {
    ...entity,
    slotKinds: selectableEquipment || selectablePassive
      ? entity.slotKinds ?? unknown(SLOT_UNKNOWN_REASON, entity.sources)
      : entity.slotKinds ?? notApplicable('This reference kind is not assigned to equipment or passive slots'),
    ppCost: selectablePassive
      ? entity.ppCost ?? unknown(PP_UNKNOWN_REASON, entity.sources)
      : entity.ppCost ?? notApplicable('PP cost does not apply to this reference kind'),
    ...(contributions ? { listedContributions: contributions } : {}),
    requirements: permissionBearing
      ? entity.requirements ?? unknown(REQUIREMENTS_UNKNOWN_REASON, entity.sources)
      : entity.requirements ?? notApplicable('Build requirements do not apply to this reference kind'),
    grants: entity.kind === 'class' || selectablePassive
      ? entity.grants ?? unknown(GRANTS_UNKNOWN_REASON, entity.sources)
      : entity.grants ?? notApplicable('This reference kind does not grant build permissions'),
  }
}

function mergeWikiEntity(record: typeof STARTER_NAME_RECORDS[number], wikiEntity: CatalogEntity): CatalogEntity {
  const baseSource = sourceForRecord(record)
  return applyPlanningKnowledge({
    ...wikiEntity,
    id: record[0] as EntityId,
    aliases: Array.from(new Set([...wikiEntity.aliases, ...(record[2] === wikiEntity.name ? [] : [record[2]])])),
    sources: uniqueSources([baseSource, ...wikiEntity.sources]),
    legacy: {
      starterIdentitySource: JSON.parse(JSON.stringify(baseSource)) as JsonValue,
      wiki: wikiEntity.legacy ?? null,
    },
  })
}

const wikiByIdentity = new Map(WIKI_DATA.entities.map((entity) => [entityIdentity(entity.kind, entity.name), entity]))
const wikiById = new Map(WIKI_DATA.entities.map(entity => [entity.id, entity]))
const starterByIdentity = new Map(STARTER_NAME_RECORDS.map((record) => [entityIdentity(record[1], record[2]), record]))
const matchedWikiIdentities = new Set<string>()
const mergedEntities: CatalogEntity[] = []

for (const record of STARTER_NAME_RECORDS) {
  const identity = entityIdentity(record[1], record[2])
  const wikiEntity = wikiByIdentity.get(identity) ?? wikiById.get(record[0] as EntityId)
  if (wikiEntity) {
    matchedWikiIdentities.add(entityIdentity(wikiEntity.kind, wikiEntity.name))
    mergedEntities.push(mergeWikiEntity(record, wikiEntity))
  } else {
    mergedEntities.push(namesOnlyEntity(record))
  }
}

for (const wikiEntity of WIKI_DATA.entities) {
  const identity = entityIdentity(wikiEntity.kind, wikiEntity.name)
  if (matchedWikiIdentities.has(identity) || starterByIdentity.has(identity)) continue
  mergedEntities.push(applyPlanningKnowledge({ ...wikiEntity, id: wikiEntity.id as EntityId }))
}

function starterDefinitions(includeModLearning: boolean): readonly CatalogEntity[] {
  const definitions = [...mergedEntities]
  // Keep confirmed Switch identities separate from same-name wiki definitions
  for (const entity of confirmedSwitchDefinitions(definitions, { includeModLearning })) {
    const index = definitions.findIndex(existing => existing.id === entity.id)
    if (index < 0) definitions.push(applyPlanningKnowledge(entity))
    else definitions[index] = applyPlanningKnowledge(entity)
  }
  return definitions
}

const unmatchedStarterRecords = STARTER_NAME_RECORDS.filter((record) => !matchedWikiIdentities.has(entityIdentity(record[1], record[2])))

export const STARTER_CATALOG_GAPS = deepFreeze({
  namesWithoutWikiDetails: unmatchedStarterRecords.map(([, kind, name, source]) => ({ kind, name, source: STARTER_SOURCE_URLS[source] })),
  wikiRedlinks: [...WIKI_DATA.coverage.redlinks],
  extractionIssues: [...WIKI_DATA.coverage.issues],
  pagesWithoutStandaloneDefinitions: [...WIKI_DATA.coverage.unimportedPages],
  knownMissingFamilies: [
    { subject: 'Bloodmage and Forcemage', missing: 'Class commands, abilities, passives, growth, equipment permissions, unlocks, and master locations' },
    { subject: 'Barbarian, Tempest, Brawler, and Freelancer', missing: 'Skill mechanics and costs, class growth, equipment permissions, unlocks, and master locations; Brawler and Freelancer mod ownership' },
    { subject: 'Equipment Expansion', missing: 'Wiki detail for unmatched equipment names and verification against the Switch-bundled revision' },
    { subject: 'Passive Trainer', missing: 'NPC identities, locations, taught passives, and costs' },
    { subject: 'Doge Shield', missing: 'Stats, exact counter behavior, location, and acquisition details' },
    { subject: 'Yasha Tar, Pinga, Quintar Husk, and Elder Entities', missing: 'Boss stats, abilities, rewards, locations, and the names and stats of associated new equipment' },
  ],
})

const coverageSource: SourceRef = {
  sourceId: 'https://crystal-project.fandom.com/wiki/Special:Statistics',
  locator: 'Generated catalog coverage report',
  snapshot: `latest source revision ${WIKI_DATA.maxRevision}`,
  applicability: SOURCE_APPLICABILITY,
}

const coverageEntity = applyPlanningKnowledge({
  id: 'base:other:catalog-coverage-gaps' as EntityId,
  kind: 'other',
  name: 'Wiki catalog coverage gaps',
  aliases: ['Missing wiki details', 'Unresolved wiki coverage'],
  rawDescription: 'Known gaps retained by the bundled wiki extraction instead of being guessed or silently omitted.',
  fields: {
    Category: known(['Catalog metadata'], [coverageSource]),
    'Existing names without wiki details': known(STARTER_CATALOG_GAPS.namesWithoutWikiDetails, [coverageSource]),
    'Referenced pages that do not exist': known(STARTER_CATALOG_GAPS.wikiRedlinks, [coverageSource]),
    'Extraction issues': known(STARTER_CATALOG_GAPS.extractionIssues, [coverageSource]),
    'Pages without standalone definitions': known(STARTER_CATALOG_GAPS.pagesWithoutStandaloneDefinitions, [coverageSource]),
    'Known catalog families without full details': known(STARTER_CATALOG_GAPS.knownMissingFamilies, [MOD_PACK_2_SOURCE, SWITCH_CLASS_SOURCE]),
    'Nintendo Switch and mod-pack parity': unknown('The community wiki does not establish complete Nintendo Switch or official mod-pack parity', [coverageSource]),
  },
  sources: [coverageSource],
})

const officialEntities: readonly CatalogEntity[] = [
  applyPlanningKnowledge({
    id: 'mod:quality-fun:other:quality-fun' as EntityId,
    kind: 'other',
    name: 'Mod Pack 1: Quality Fun',
    aliases: ['Quality Fun'],
    rawDescription: 'Nintendo Switch mod collection containing quality-of-life and rules changes that are enabled per save.',
    fields: {
      Category: known(['Nintendo Switch DLC'], [MOD_PACK_1_SOURCE]),
      Mods: known([
        { name: 'Appearance Passives', effect: 'Allows a character to use the appearance of any class.' },
        { name: 'Pointier Hat', effect: 'Adds a hidden bonus late-game hat.' },
        { name: 'Golden Quintar High Jump', effect: 'Raises Golden Quintar jump height from two blocks to three.' },
        { name: 'Cheap Maps', effect: 'Reduces all map costs.' },
        { name: "Cheap Teleport Shards n' Stones", effect: 'Reduces teleport shard and stone costs.' },
        { name: 'Learnable Innate Skills', effect: 'Makes innate class passives learnable.' },
        { name: '1 PP Passives', effect: 'Changes all passive costs to 1 PP.' },
        { name: 'Unrestricted Weapon Skills', effect: 'Removes weapon-type restrictions from weapon skills.' },
        { name: 'Free Maps', effect: 'Allows obtaining all maps from Nan at Old Nan\'s Watering Hole.' },
        { name: 'Modern Kids', effect: 'Changes the dialogue of children in Capital Sequoia.' },
      ], [MOD_PACK_1_SOURCE]),
      'Exact bundled revision': unknown('The publisher description does not expose the bundled mod source revisions', [MOD_PACK_1_SOURCE]),
    },
    sources: [MOD_PACK_1_SOURCE],
  }),
  applyPlanningKnowledge({
    id: 'mod:new-challenges:other:new-challenges' as EntityId,
    kind: 'other',
    name: 'Mod Pack 2: New Challenges',
    aliases: ['New Challenges'],
    rawDescription: 'Nintendo Switch mod collection containing tools, equipment, classes, and additional bosses that are enabled per save.',
    fields: {
      Category: known(['Nintendo Switch DLC'], [MOD_PACK_2_SOURCE]),
      Contents: known(['Passive Trainer', 'Doge Shield', 'Equipment Expansion', 'Moonlight Project Custom Classes', 'Bloodmage', 'Yasha Tar', 'Pinga', 'Tempest', 'Forcemage', 'Barbarian', 'Quintar Husk', 'Elder Entities'], [MOD_PACK_2_SOURCE]),
      'Exact bundled revision': unknown('The publisher description does not expose the bundled mod source revisions', [MOD_PACK_2_SOURCE]),
    },
    sources: [MOD_PACK_2_SOURCE],
  }),
  applyPlanningKnowledge({
    id: 'mod:passive-trainer:other:passive-trainer' as EntityId,
    kind: 'other',
    name: 'Passive Trainer',
    aliases: [],
    rawDescription: 'Adds three NPCs around the world that teach passives for a cost.',
    fields: {
      Category: known(['Mod Pack 2 feature'], [MOD_PACK_2_SOURCE]),
      'Trainer count': known(3, [MOD_PACK_2_SOURCE]),
      Description: known('Adds NPCs around the world that teach passives for a cost.', [MOD_PACK_2_SOURCE]),
      'Missing details': known(['NPC identities', 'Locations', 'Taught passives', 'Costs'], [MOD_PACK_2_SOURCE]),
    },
    sources: [MOD_PACK_2_SOURCE],
  }),
  applyPlanningKnowledge({
    id: 'mod:doge-shield:item:doge-shield' as EntityId,
    kind: 'item',
    name: 'Doge Shield',
    aliases: [],
    rawDescription: 'Shield that triggers a counter when its user is attacked, similar to the Duelling Shield.',
    fields: {
      Category: known(['Shields', 'Mod Pack 2 item'], [MOD_PACK_2_SOURCE]),
      'Source mod': known('Doge Shield', [MOD_PACK_2_SOURCE]),
      Description: known('Triggers a counter when its user is attacked, similar to the Duelling Shield.', [MOD_PACK_2_SOURCE]),
      'Missing details': known(['Stats', 'Counter formula', 'Counter trigger restrictions', 'Location', 'Acquisition'], [MOD_PACK_2_SOURCE]),
      Location: unknown('The publisher description does not document the shield location or acquisition method', [MOD_PACK_2_SOURCE]),
    },
    sources: [MOD_PACK_2_SOURCE],
  }),
  ...[
    ['Yasha Tar', true],
    ['Pinga', true],
    ['Quintar Husk', false],
    ['Elder Entities', true],
  ].map(([name, addsEquipment]) => applyPlanningKnowledge({
    id: `mod:additional-boss-${String(name).toLocaleLowerCase().replace(/\s+/g, '-')}:monster:${String(name).toLocaleLowerCase().replace(/\s+/g, '-')}` as EntityId,
    kind: 'monster',
    name: String(name),
    aliases: [],
    rawDescription: `Additional boss included by Mod Pack 2${addsEquipment ? ' with a new piece of equipment' : ''}.`,
    fields: {
      Category: known(['Mod Pack 2 boss'], [MOD_PACK_2_SOURCE]),
      'Source mod': known(`Additional Boss: ${String(name)}`, [MOD_PACK_2_SOURCE]),
      Description: known(`Additional boss${addsEquipment ? ' with a new piece of equipment' : ''}.`, [MOD_PACK_2_SOURCE]),
      Level: unknown('The publisher description does not document boss level', [MOD_PACK_2_SOURCE]),
      HP: unknown('The publisher description does not document boss HP', [MOD_PACK_2_SOURCE]),
      Location: unknown('The publisher description does not document boss location', [MOD_PACK_2_SOURCE]),
      Abilities: unknown('The publisher description does not document boss abilities', [MOD_PACK_2_SOURCE]),
      Drops: unknown('The publisher description does not document boss drops', [MOD_PACK_2_SOURCE]),
      Steals: unknown('The publisher description does not document boss steals', [MOD_PACK_2_SOURCE]),
      ...(addsEquipment ? { 'Associated equipment': unknown('The publisher description does not name or detail the new equipment', [MOD_PACK_2_SOURCE]) } : {}),
    },
    sources: [MOD_PACK_2_SOURCE],
  })),
]

mergedEntities.push(coverageEntity, ...officialEntities)

const starterEntities = starterDefinitions(true)

export const STARTER_CATALOG_COUNTS = deepFreeze(
  starterEntities.reduce<Partial<Record<CatalogEntityKind, number>>>((counts, entity) => {
    counts[entity.kind] = (counts[entity.kind] ?? 0) + 1
    return counts
  }, {}),
)

export function createReferenceSupplementCatalog({ includeModLearning = false }: { readonly includeModLearning?: boolean } = {}): CatalogSnapshot {
  const entities = Object.fromEntries(starterDefinitions(includeModLearning).map(entity => [entity.id, entity]))
  return {
    id: STARTER_CATALOG_ID,
    revisionId: STARTER_CATALOG_REVISION_ID,
    schemaVersion: '1.0.0',
    checksum: `builtin:sha256:${STARTER_CATALOG_CONTENT_DIGEST}`,
    importedAt: WIKI_DATA.maxRevision as Timestamp,
    applicability: {
      state: 'unknown',
      reason: 'The community wiki and supporting public sources do not establish complete Nintendo Switch or official mod-pack parity',
    },
    rights: {
      state: 'unknown',
      reason: `Wiki-derived content is ${WIKI_DATA.source.rights} with page-level attribution; supporting catalog sources have separate terms`,
      sources: [{ sourceId: WIKI_DATA.source.rightsUrl, locator: WIKI_DATA.source.name }],
    },
    entities,
    claims: [],
    legacy: {
      coverage: 'community-wiki-with-explicit-gaps',
      provenance: 'revision-pinned-public-sources-and-in-game-confirmations',
      wikiContentDigest: WIKI_DATA.contentDigest,
    },
  }
}

export const STARTER_CATALOG: CatalogSnapshot = deepFreeze(createReferenceSupplementCatalog({ includeModLearning: true }))
