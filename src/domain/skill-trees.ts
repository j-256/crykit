import { asTimestamp, assertExpectedRevision, createId, DomainError, nowTimestamp, updateProfile } from './core'
import { logicalEntityKey, resolveDefinition, sameLogicalEntity } from './definitions'
import type { CatalogSnapshot, CharacterId, EntityRef, Knowledge, Profile, RulesetRevisionId, SkillSquare, SkillTreeCapture, SkillTreeLayout, SkillTreeMapping, SourceRef, Timestamp } from './types'

export const SKILL_GRID_COLUMNS = 4
export const SKILL_GRID_ROWS = 6
export const MAX_SKILL_CAPTURES = 64
export const SKILL_SQUARE_STATES = ['learned', 'available', 'locked', 'unknown'] as const

export function squareKey(square: Pick<SkillSquare, 'row' | 'column'>): string {
  return `${square.row}:${square.column}`
}

export function skillTreeShape(squares: readonly Pick<SkillSquare, 'row' | 'column'>[]): string {
  return squares.map(squareKey).sort().join(',')
}

export function findSkillTreeLayout(profile: Profile, classRef: EntityRef, squares: readonly SkillSquare[], rulesetRevisionId?: RulesetRevisionId): SkillTreeLayout | undefined {
  return Object.values(profile.skillTreeLayouts ?? {}).find(layout => sameLogicalEntity(profile, classRef, layout.classRef) && layout.rulesetRevisionId === rulesetRevisionId && layout.shape === skillTreeShape(squares))
}

export interface ReviewedSkillTree {
  readonly characterId: CharacterId
  readonly classRef: EntityRef
  readonly rulesetRevisionId?: RulesetRevisionId
  readonly sourceDigest: string
  readonly filename: string
  readonly squares: readonly SkillSquare[]
  readonly mappings: readonly SkillTreeMapping[]
  readonly reviewed: boolean
}

function invalid(message: string): never { throw new DomainError('INVALID_INPUT', message) }

export function assertSkillTreeGeometry(squares: readonly Pick<SkillSquare, 'row' | 'column'>[]): void {
  if (!squares.length || squares.length > SKILL_GRID_COLUMNS * SKILL_GRID_ROWS) invalid('The skill tree has no supported grid')
  const positions = new Set<string>()
  for (const square of squares) {
    if (!Number.isInteger(square.row) || square.row < 0 || square.row >= SKILL_GRID_ROWS || !Number.isInteger(square.column) || square.column < 0 || square.column >= SKILL_GRID_COLUMNS) invalid('A skill square is outside the supported grid')
    if (positions.has(squareKey(square))) invalid('A skill square appears twice')
    positions.add(squareKey(square))
  }
}

function combineObservation(prior: Knowledge<boolean> | undefined, value: boolean, source: SourceRef): Knowledge<boolean> {
  const incoming = { value, sources: [source] }
  if (!prior || prior.state === 'unknown' || prior.state === 'notApplicable') return { state: 'known', value, sources: [source] }
  if (prior.state === 'known' && prior.value === value) return { ...prior, sources: [...(prior.sources ?? []), source] }
  const claims = prior.state === 'conflicting' ? prior.claims : [{ value: prior.value, sources: prior.sources ?? [] }]
  return { state: 'conflicting', claims: [...claims, incoming] }
}

function extendsMappings(profile: Profile, before: readonly SkillTreeMapping[], after: readonly SkillTreeMapping[]): boolean {
  return before.every(prior => after.some(next => squareKey(prior) === squareKey(next) && prior.kind === next.kind && sameLogicalEntity(profile, prior.ref, next.ref)))
}

export function importSkillTrees(profile: Profile, catalogs: readonly CatalogSnapshot[], captures: readonly ReviewedSkillTree[], expectedRevision: number, now?: Timestamp | string): Profile {
  assertExpectedRevision(profile, expectedRevision)
  if (!captures.length || captures.length > MAX_SKILL_CAPTURES) invalid('Choose a supported batch of screenshots')
  const at = now === undefined ? nowTimestamp() : asTimestamp(now)
  const characters = { ...profile.characters }
  const layouts = { ...profile.skillTreeLayouts }
  const observations = { ...profile.skillTreeCaptures }
  let changed = false
  for (const capture of captures) {
    if (!capture.reviewed) invalid('Review each screenshot before saving')
    const character = characters[capture.characterId]
    if (!character) invalid('The screenshot character is unavailable')
    if (resolveDefinition(profile, catalogs, capture.classRef)?.kind !== 'class') invalid('Choose an exact class definition for the screenshot')
    if (capture.rulesetRevisionId !== undefined && !Object.hasOwn(profile.rulesets, capture.rulesetRevisionId)) invalid('The screenshot ruleset is unavailable')
    if (!/^[a-f0-9]{64}$/.test(capture.sourceDigest)) invalid('The screenshot fingerprint is invalid')
    if (!capture.filename.trim() || capture.filename.length > 256 || /[/\\]/.test(capture.filename)) invalid('Use a screenshot filename without a path')
    assertSkillTreeGeometry(capture.squares)
    if (capture.squares.some(square => !SKILL_SQUARE_STATES.includes(square.state))) invalid('A skill square has an unsupported state')
    const positions = new Set(capture.squares.map(squareKey))
    const mappedPositions = new Set<string>()
    const mappedRefs = new Set<string>()
    for (const mapping of capture.mappings) {
      if (!positions.has(squareKey(mapping)) || mappedPositions.has(squareKey(mapping))) invalid('A mapping must identify one visible square')
      const key = logicalEntityKey(profile, mapping.ref)
      if (mappedRefs.has(key)) invalid('One ability cannot be assigned to multiple squares in the same tree')
      if (!['ability', 'passive', 'innate', 'monsterMagic'].includes(mapping.kind) || resolveDefinition(profile, catalogs, mapping.ref)?.kind !== mapping.kind) invalid('A square must link to an available ability, passive, innate, or Monster Magic definition')
      mappedPositions.add(squareKey(mapping))
      mappedRefs.add(key)
    }
    const duplicate = Object.values(observations).find(entry => entry.sourceDigest === capture.sourceDigest && entry.characterId === capture.characterId && sameLogicalEntity(profile, entry.classRef, capture.classRef) && entry.rulesetRevisionId === capture.rulesetRevisionId)
    if (duplicate) {
      if (JSON.stringify(duplicate.squares) !== JSON.stringify(capture.squares) || !extendsMappings(profile, duplicate.mappings, capture.mappings)) invalid('This screenshot was already imported with different review choices. Undo that import before replacing it')
      if (duplicate.mappings.length === capture.mappings.length) continue
    }
    const source: SourceRef = { sourceId: `screenshot:${capture.sourceDigest}`, locator: capture.filename, checkedAt: at, applicability: 'Reviewed character-specific Learn screen' }
    const learnedNodes = { ...character.learnedNodes }
    for (const mapping of capture.mappings) {
      if (duplicate?.mappings.some(prior => squareKey(prior) === squareKey(mapping))) continue
      const square = capture.squares.find(entry => squareKey(entry) === squareKey(mapping))!
      if (square.state === 'unknown') continue
      const key = logicalEntityKey(profile, mapping.ref)
      const prior = learnedNodes[key]
      learnedNodes[key] = { ref: mapping.ref, kind: mapping.kind, learned: combineObservation(prior?.learned, square.state === 'learned', source), actualPaidLp: prior?.actualPaidLp ?? { state: 'unknown' }, sources: [...(prior?.sources ?? []), source] }
    }
    const priorLayout = findSkillTreeLayout({ ...profile, skillTreeLayouts: layouts }, capture.classRef, capture.squares, capture.rulesetRevisionId)
    if (priorLayout && !extendsMappings(profile, priorLayout.mappings, capture.mappings)) invalid('The reviewed mappings disagree with the saved class layout. Use a separate ruleset for a different tree')
    const layoutId = priorLayout?.id ?? createId('skillLayout')
    layouts[layoutId] = { id: layoutId, classRef: capture.classRef, ...(capture.rulesetRevisionId ? { rulesetRevisionId: capture.rulesetRevisionId } : {}), shape: skillTreeShape(capture.squares), mappings: capture.mappings }
    const id = duplicate?.id ?? createId('skillCapture')
    const observation: SkillTreeCapture = { id, characterId: capture.characterId, classRef: capture.classRef, ...(capture.rulesetRevisionId ? { rulesetRevisionId: capture.rulesetRevisionId } : {}), sourceDigest: capture.sourceDigest, filename: capture.filename, recordedAt: at, squares: capture.squares, mappings: capture.mappings }
    observations[id] = observation
    characters[character.id] = { ...character, revision: character.revision + 1, learnedNodes, updatedAt: at }
    changed = true
  }
  return changed ? updateProfile(profile, { characters, skillTreeLayouts: layouts, skillTreeCaptures: observations }, 'character.skillTrees.import', ['characters', 'skillTreeLayouts', 'skillTreeCaptures'], at) : profile
}
