import {
  asTimestamp,
  assertExpectedRevision,
  assertPersonalDefinitionRef,
  assertTextLength,
  createId,
  DomainError,
  nowTimestamp,
  updateProfile,
} from './core'
import { MAX_SHORT_TEXT_LENGTH } from './limits'
import type {
  Build,
  BuildId,
  BuildKind,
  BuildRevision,
  BuildRevisionContent,
  BuildRevisionId,
  BuildState,
  CatalogRevisionId,
  CharacterId,
  Profile,
  RulesetRevisionId,
  Timestamp,
} from './types'

export interface CreateBuildInput {
  readonly id?: BuildId
  readonly title: string
  readonly kind: BuildKind
  readonly characterId?: CharacterId
  readonly state?: BuildState
  readonly tags?: readonly string[]
  readonly favorite?: boolean
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

export function createBuild(profile: Profile, input: CreateBuildInput): Profile {
  assertExpectedRevision(profile, input.expectedRevision)
  const title = input.title.trim()
  if (!title) {
    throw new DomainError('INVALID_INPUT', 'Build title must not be empty')
  }
  assertTextLength(title, 'Build title', MAX_SHORT_TEXT_LENGTH)
  if (input.characterId && !profile.characters[input.characterId]) {
    throw new DomainError('MISSING_CHARACTER', `Character does not exist: ${input.characterId}`)
  }
  const id = input.id ?? createId<BuildId>('build')
  if (profile.builds[id]) {
    throw new DomainError('DUPLICATE_ID', `Build already exists: ${id}`)
  }
  const at = input.now === undefined ? nowTimestamp() : asTimestamp(input.now)
  const build: Build = {
    id,
    revision: 0,
    title,
    kind: input.kind,
    state: input.state ?? 'draft',
    tags: input.tags ?? [],
    favorite: input.favorite ?? false,
    createdAt: at,
    updatedAt: at,
    ...(input.characterId === undefined ? {} : { characterId: input.characterId }),
  }
  return updateProfile(
    profile,
    { builds: { ...profile.builds, [id]: build } },
    'build.create',
    [`builds.${id}`],
    at,
  )
}

export interface UpdateBuildInput {
  readonly buildId: BuildId
  readonly title?: string
  readonly state?: BuildState
  readonly tags?: readonly string[]
  readonly favorite?: boolean
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

export function updateBuild(profile: Profile, input: UpdateBuildInput): Profile {
  assertExpectedRevision(profile, input.expectedRevision)
  const current = profile.builds[input.buildId]
  if (!current) {
    throw new DomainError('MISSING_BUILD', `Build does not exist: ${input.buildId}`)
  }
  const title = input.title?.trim() ?? current.title
  if (!title) {
    throw new DomainError('INVALID_INPUT', 'Build title must not be empty')
  }
  assertTextLength(title, 'Build title', MAX_SHORT_TEXT_LENGTH)
  const at = input.now === undefined ? nowTimestamp() : asTimestamp(input.now)
  const build: Build = {
    ...current,
    title,
    state: input.state ?? current.state,
    tags: input.tags ?? current.tags,
    favorite: input.favorite ?? current.favorite,
    revision: current.revision + 1,
    updatedAt: at,
  }
  return updateProfile(
    profile,
    { builds: { ...profile.builds, [build.id]: build } },
    'build.update',
    [`builds.${build.id}`],
    at,
  )
}

export interface CloneBuildInput {
  readonly sourceBuildId: BuildId
  readonly id?: BuildId
  readonly revisionId?: BuildRevisionId
  readonly title?: string
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

export function cloneBuild(profile: Profile, input: CloneBuildInput): Profile {
  assertExpectedRevision(profile, input.expectedRevision)
  const source = profile.builds[input.sourceBuildId]
  if (!source) {
    throw new DomainError('MISSING_BUILD', `Build does not exist: ${input.sourceBuildId}`)
  }
  const sourceRevision = source.latestRevisionId
    ? profile.buildRevisions[source.latestRevisionId]
    : undefined
  if (!sourceRevision || sourceRevision.buildId !== source.id) {
    throw new DomainError('MISSING_BUILD_REVISION', 'Build must have a latest revision before it can be cloned')
  }
  const title = input.title === undefined ? `${source.title} (copy)` : input.title.trim()
  if (!title) {
    throw new DomainError('INVALID_INPUT', 'Build title must not be empty')
  }
  assertTextLength(title, 'Build title', MAX_SHORT_TEXT_LENGTH)
  const id = input.id ?? createId<BuildId>('build')
  if (profile.builds[id]) {
    throw new DomainError('DUPLICATE_ID', `Build already exists: ${id}`)
  }
  const revisionId = input.revisionId ?? createId<BuildRevisionId>('buildRevision')
  if (profile.buildRevisions[revisionId]) {
    throw new DomainError('DUPLICATE_ID', `Build revision already exists: ${revisionId}`)
  }
  const at = input.now === undefined ? nowTimestamp() : asTimestamp(input.now)
  const content: BuildRevisionContent = {
    primaryClass: sourceRevision.content.primaryClass,
    secondaryClass: sourceRevision.content.secondaryClass,
    selections: Object.fromEntries(Object.entries(sourceRevision.content.selections).map(([slotId, selection]) => [
      slotId,
      selection === null ? null : { ...selection },
    ])),
    ...(sourceRevision.content.rotationNotes === undefined ? {} : { rotationNotes: sourceRevision.content.rotationNotes }),
    contextAssumptions: [...sourceRevision.content.contextAssumptions],
  }
  const revision: BuildRevision = {
    id: revisionId,
    buildId: id,
    revision: 1,
    rulesetRevisionId: sourceRevision.rulesetRevisionId,
    catalogLock: { ...sourceRevision.catalogLock },
    content,
    createdAt: at,
    ...(sourceRevision.note === undefined ? {} : { note: sourceRevision.note }),
  }
  const build: Build = {
    id,
    revision: 1,
    title,
    kind: source.kind,
    state: 'draft',
    tags: [...source.tags],
    favorite: source.favorite,
    latestRevisionId: revisionId,
    createdAt: at,
    updatedAt: at,
    ...(source.characterId === undefined ? {} : { characterId: source.characterId }),
  }
  return updateProfile(
    profile,
    {
      builds: { ...profile.builds, [id]: build },
      buildRevisions: { ...profile.buildRevisions, [revisionId]: revision },
    },
    'build.clone',
    [`builds.${id}`, `buildRevisions.${revisionId}`],
    at,
  )
}

export interface SaveBuildRevisionInput {
  readonly buildId: BuildId
  readonly id?: BuildRevisionId
  readonly parentRevisionId?: BuildRevisionId
  readonly rulesetRevisionId: RulesetRevisionId
  readonly catalogLock?: Readonly<Record<string, CatalogRevisionId>>
  readonly content: BuildRevisionContent
  readonly note?: string
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

export function saveBuildRevision(profile: Profile, input: SaveBuildRevisionInput): Profile {
  assertExpectedRevision(profile, input.expectedRevision)
  const current = profile.builds[input.buildId]
  if (!current) {
    throw new DomainError('MISSING_BUILD', `Build does not exist: ${input.buildId}`)
  }
  const ruleset = profile.rulesets[input.rulesetRevisionId]
  if (!ruleset) {
    throw new DomainError('MISSING_RULESET', `Ruleset revision does not exist: ${input.rulesetRevisionId}`)
  }
  if (input.parentRevisionId) {
    const parent = profile.buildRevisions[input.parentRevisionId]
    if (!parent || parent.buildId !== input.buildId) {
      throw new DomainError('MISSING_BUILD_REVISION', 'Parent build revision does not belong to this build')
    }
  }
  const id = input.id ?? createId<BuildRevisionId>('buildRevision')
  if (profile.buildRevisions[id]) {
    throw new DomainError('DUPLICATE_ID', `Build revision already exists: ${id}`)
  }
  const catalogLock = input.catalogLock ?? ruleset.catalogLock
  const slotIds = new Set(ruleset.slots.map((slot) => slot.id as string))
  const assertBuildRef = (ref: import('./types').EntityRef, label: string) => {
    assertPersonalDefinitionRef(profile, ref)
    if (ref.kind === 'catalog' && catalogLock[ref.catalogId] !== ref.catalogRevisionId) {
      throw new DomainError('INVALID_INPUT', `${label} falls outside the build catalog lock`)
    }
  }
  if (input.content.primaryClass) assertBuildRef(input.content.primaryClass, 'Primary class')
  if (input.content.secondaryClass) assertBuildRef(input.content.secondaryClass, 'Secondary class')
  for (const [slotId, selection] of Object.entries(input.content.selections)) {
    if (!slotId.trim() || !slotIds.has(slotId)) {
      throw new DomainError('INVALID_INPUT', `Build selection references an unknown ruleset slot: ${slotId}`)
    }
    if (!selection) continue
    assertBuildRef(selection.ref, `Selection ${slotId}`)
    if (selection.allocationId !== undefined && !selection.allocationId.trim()) {
      throw new DomainError('INVALID_INPUT', 'Allocation ID must not be empty')
    }
  }
  const at = input.now === undefined ? nowTimestamp() : asTimestamp(input.now)
  const revision: BuildRevision = {
    id,
    buildId: input.buildId,
    revision: current.revision + 1,
    rulesetRevisionId: input.rulesetRevisionId,
    catalogLock,
    content: input.content,
    createdAt: at,
    ...(input.parentRevisionId === undefined ? {} : { parentRevisionId: input.parentRevisionId }),
    ...(input.note === undefined ? {} : { note: input.note }),
  }
  const build: Build = {
    ...current,
    revision: current.revision + 1,
    latestRevisionId: id,
    updatedAt: at,
  }
  return updateProfile(
    profile,
    {
      builds: { ...profile.builds, [build.id]: build },
      buildRevisions: { ...profile.buildRevisions, [id]: revision },
    },
    'build.saveRevision',
    [`builds.${build.id}`, `buildRevisions.${id}`],
    at,
  )
}
