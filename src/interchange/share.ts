import { saveTeam } from '../domain/teams'
import { deflateSync, inflateSync } from 'fflate'
import { z } from 'zod'
import { createId, nowTimestamp, requirePlaythrough, updateLocalData } from '../domain/core'
import { createBlankLocalData } from '../domain/local-data'
import { effectiveScenarioAssignments, TEAM_SIZE } from '../domain/scenarios'
import { modCatalogRevision } from '../domain/mod-layers'
import { sameCorrectionValue } from '../domain/corrections'
import { sameBuildBehavior, uniqueGameSetupLabel } from '../domain/build-behavior'
import type { Build, BuildId, BuildRevision, BuildRevisionId, EntityRef, GameSetupId, GameSetupRevision, GameSetupRevisionId, TeamId, LocalData, PersonalDefinition, PersonalDefinitionId, ScenarioId } from '../domain/types'
import { NativeLocalDataSchema, StoredBuildSchema } from './native-schema'
import { parseBoundedJson } from './json'

const SHARE_FORMAT_VERSION = 3
export const SHARE_VERSION = `v${SHARE_FORMAT_VERSION}`
export const SHARE_ROUTE_PREFIX = `#/share/${SHARE_VERSION}/`
export const MAX_SHARE_URL_LENGTH = 64 * 1024
export const MAX_SHARE_JSON_BYTES = 1024 * 1024
const LENGTH_HEADER_BYTES = 4
const BASE64_CHUNK_BYTES = 8192
const SHARE_COMPRESSION_LEVEL = 9
const SHARE_RECORDS_SCHEMA = NativeLocalDataSchema.pick({ personalDefinitions: true, gameSetups: true, builds: true, buildRevisions: true })
const CurrentShareSchema = z.object({
  version: z.literal(SHARE_FORMAT_VERSION),
  kind: z.enum(['build', 'team']),
  title: NativeLocalDataSchema.shape.builds.valueType.shape.title,
  records: SHARE_RECORDS_SCHEMA,
  slots: z.array(z.string().min(1).nullable()).length(TEAM_SIZE).optional(),
  teamGameSetupRevisionId: z.string().min(1).optional(),
}).strict()
const ShareSchema = z.union([
  CurrentShareSchema,
  CurrentShareSchema.extend({ version: z.union([z.literal(1), z.literal(2)]), records: SHARE_RECORDS_SCHEMA.extend({ builds: z.record(NativeLocalDataSchema.shape.builds.keyType, StoredBuildSchema) }) }),
])

export interface SharePayload {
  readonly version: 1 | 2 | 3
  readonly kind: 'build' | 'team'
  readonly title: string
  readonly records: Pick<LocalData, 'personalDefinitions' | 'gameSetups' | 'builds' | 'buildRevisions'>
  readonly slots?: readonly (BuildRevisionId | null)[]
  readonly teamGameSetupRevisionId?: GameSetupRevisionId
}
export type ShareTarget = { readonly kind: 'build'; readonly revisionId: BuildRevisionId } | { readonly kind: 'team'; readonly scenarioId: ScenarioId } | { readonly kind: 'team'; readonly teamId: TeamId }

function own<T>(records: Readonly<Record<string, T>>, id: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(records, id) ? records[id] : undefined
}

function visitRefs(value: unknown, visit: (ref: EntityRef) => void): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) { for (const entry of value) visitRefs(entry, visit); return }
  const entry = value as Record<string, unknown>
  if ((entry.kind === 'personal' && typeof entry.definitionId === 'string') || (entry.kind === 'catalog' && typeof entry.catalogId === 'string' && typeof entry.catalogRevisionId === 'string' && typeof entry.entityId === 'string')) visit(entry as unknown as EntityRef)
  else for (const child of Object.values(entry)) visitRefs(child, visit)
}

function definitionReferences(definition: PersonalDefinition) {
  return { baseRef: definition.baseRef, previousRevision: definition.previousRevision, requirements: definition.requirements }
}

export function createSharePayload(localData: LocalData, target: ShareTarget, includeNotes = false): SharePayload {
  const definitions: Record<string, PersonalDefinition> = {}
  const setups: Record<string, GameSetupRevision> = {}
  const builds: Record<string, Build> = {}
  const revisions: Record<string, BuildRevision> = {}
  const addRef = (ref: EntityRef) => {
    if (ref.kind !== 'personal' || own(definitions, ref.definitionId)) return
    const definition = own(localData.personalDefinitions, ref.definitionId)
    if (!definition) throw new Error('A referenced personal definition is missing.')
    definitions[definition.id] = definition
    visitRefs(definitionReferences(definition), addRef)
  }
  const addSetup = (id: GameSetupRevisionId) => {
    if (own(setups, id)) return
    const setup = own(localData.gameSetups, id)
    if (!setup) throw new Error('The pinned Game Setup is missing.')
    setups[id] = setup
    visitRefs(setup.definitionOverrides, addRef)
    for (const revision of Object.values(setup.catalogLock)) {
      const origin = Object.values(localData.gameSetups).find(candidate => modCatalogRevision(candidate.id) === revision)
      if (origin) addSetup(origin.id)
    }
  }
  const addRevision = (id: BuildRevisionId) => {
    if (own(revisions, id)) return
    const revision = own(localData.buildRevisions, id)
    const build = revision && own(localData.builds, revision.buildId)
    if (!revision || !build) throw new Error('A pinned build checkpoint is missing.')
    addSetup(revision.gameSetupRevisionId)
    const { rotationNotes, contextAssumptions, ...content } = revision.content
    revisions[id] = {
      id, buildId: build.id, revision: revision.revision, gameSetupRevisionId: revision.gameSetupRevisionId,
      catalogLock: revision.catalogLock, createdAt: revision.createdAt,
      content: { ...content, contextAssumptions: includeNotes ? contextAssumptions : [], ...(includeNotes && rotationNotes !== undefined ? { rotationNotes } : {}) },
      ...(includeNotes && revision.note !== undefined ? { note: revision.note } : {}),
    }
    builds[build.id] = { ...build, gameSetupId: setups[revision.gameSetupRevisionId]!.gameSetupId, tags: [], favorite: false, latestRevisionId: id }
    visitRefs(revision.content, addRef)
  }
  if (target.kind === 'build') {
    addRevision(target.revisionId)
    return validateSharePayload({ version: SHARE_FORMAT_VERSION, kind: 'build', title: builds[revisions[target.revisionId]!.buildId]!.title, records: { personalDefinitions: definitions, gameSetups: setups, builds, buildRevisions: revisions } })
  }
  if ('teamId' in target) {
    const team = own(localData.teams, target.teamId)
    const first = team?.slots.find(id => id !== null)
    const setupId = first ? localData.buildRevisions[first]?.gameSetupRevisionId : undefined
    if (!team || !setupId) throw new Error('Choose a build before sharing the Team.')
    for (const id of team.slots) if (id) addRevision(id)
    return validateSharePayload({ version: SHARE_FORMAT_VERSION, kind: 'team', title: team.title, records: { personalDefinitions: definitions, gameSetups: setups, builds, buildRevisions: revisions }, slots: team.slots, teamGameSetupRevisionId: setupId })
  }
  const scenario = own(requirePlaythrough(localData).scenarios, target.scenarioId)
  if (!scenario || scenario.memberIds.length !== TEAM_SIZE || new Set(scenario.memberIds).size !== TEAM_SIZE) throw new Error('Sharing requires a complete four-slot team.')
  const assignments = effectiveScenarioAssignments(scenario)
  const slots = scenario.memberIds.map(id => own(assignments, id) ?? null)
  addSetup(scenario.gameSetupRevisionId)
  for (const id of slots) if (id) addRevision(id)
  return validateSharePayload({ version: SHARE_FORMAT_VERSION, kind: 'team', title: scenario.label, records: { personalDefinitions: definitions, gameSetups: setups, builds, buildRevisions: revisions }, slots, teamGameSetupRevisionId: scenario.gameSetupRevisionId })
}

export function sharePreviewData(payload: SharePayload): LocalData {
  return { ...createBlankLocalData(), ...payload.records }
}

export function validateSharePayload(value: unknown): SharePayload {
  const result = ShareSchema.safeParse(value)
  if (!result.success) throw new Error('This shared snapshot has an unsupported or malformed format.', { cause: result.error })
  const payload = result.data as unknown as SharePayload
  const { builds, buildRevisions, gameSetups, personalDefinitions } = payload.records
  for (const records of [builds, buildRevisions, gameSetups, personalDefinitions]) {
    for (const [id, record] of Object.entries(records)) if (id !== record.id) throw new Error('A shared record has an inconsistent identity.')
  }
  for (const build of Object.values(builds)) {
    const revision = build.latestRevisionId && own(buildRevisions, build.latestRevisionId)
    if (!revision || revision.buildId !== build.id) throw new Error('A shared build has no matching checkpoint.')
  }
  for (const revision of Object.values(buildRevisions)) {
    const build = own(builds, revision.buildId)
    const setup = own(gameSetups, revision.gameSetupRevisionId)
    if (!build || !setup || payload.version === 1 && setup.gameSetupId !== build.gameSetupId || revision.parentRevisionId) throw new Error('A shared checkpoint has an invalid dependency.')
    const slots = new Set(setup.slots.map(slot => slot.id as string))
    if (Object.keys(revision.content.equipment).some(id => !slots.has(id))) throw new Error('A shared build references an unavailable equipment slot.')
  }
  const checkPersonalRef = (ref: EntityRef) => {
    if (ref.kind === 'personal' && !own(personalDefinitions, ref.definitionId)) throw new Error('A shared personal definition is missing.')
  }
  for (const definition of Object.values(personalDefinitions)) visitRefs(definitionReferences(definition), checkPersonalRef)
  for (const setup of Object.values(gameSetups)) visitRefs(setup.definitionOverrides, checkPersonalRef)
  for (const revision of Object.values(buildRevisions)) visitRefs(revision.content, checkPersonalRef)
  if (payload.kind === 'build') {
    if (Object.keys(buildRevisions).length !== 1 || Object.keys(builds).length !== 1 || payload.slots || payload.teamGameSetupRevisionId) throw new Error('A shared build must contain exactly one checkpoint.')
  } else {
    if (!payload.slots || !payload.teamGameSetupRevisionId || !own(gameSetups, payload.teamGameSetupRevisionId) || payload.slots.some(id => id !== null && !own(buildRevisions, id))) throw new Error('A shared team has an invalid slot or Game Setup.')
    const assigned = new Set(payload.slots.filter(id => id !== null))
    if (Object.keys(buildRevisions).some(id => !assigned.has(id as BuildRevisionId))) throw new Error('A shared team contains an unassigned checkpoint.')
  }
  return payload
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_BYTES))
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export function encodeSharePayload(payload: SharePayload): string {
  const bytes = new TextEncoder().encode(JSON.stringify(validateSharePayload(payload)))
  if (bytes.length > MAX_SHARE_JSON_BYTES) throw new Error('This snapshot exceeds the sharing data limit. Use a backup file to transfer larger data.')
  const compressed = deflateSync(bytes, { level: SHARE_COMPRESSION_LEVEL })
  const envelope = new Uint8Array(LENGTH_HEADER_BYTES + compressed.length)
  new DataView(envelope.buffer).setUint32(0, bytes.length)
  envelope.set(compressed, LENGTH_HEADER_BYTES)
  const encoded = base64Url(envelope)
  if (SHARE_ROUTE_PREFIX.length + encoded.length > MAX_SHARE_URL_LENGTH) throw new Error('This snapshot is too large for a share link. Shorten optional notes or use a backup file.')
  return encoded
}

export function decodeSharePayload(encoded: string): SharePayload {
  if (!encoded || encoded.length + SHARE_ROUTE_PREFIX.length > MAX_SHARE_URL_LENGTH || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('This share link is malformed or exceeds the URL limit.')
  try {
    const binary = atob(encoded.replaceAll('-', '+').replaceAll('_', '/'))
    const envelope = Uint8Array.from(binary, character => character.charCodeAt(0))
    if (envelope.length <= LENGTH_HEADER_BYTES) throw new Error('The shared snapshot is incomplete.')
    const length = new DataView(envelope.buffer).getUint32(0)
    if (length === 0 || length > MAX_SHARE_JSON_BYTES) throw new Error('The shared snapshot exceeds the sharing data limit.')
    const bytes = inflateSync(envelope.subarray(LENGTH_HEADER_BYTES), { out: new Uint8Array(length + 1) })
    if (bytes.length !== length) throw new Error('The shared snapshot is incomplete or exceeds its declared size.')
    return validateSharePayload(parseBoundedJson(bytes, 'Shared snapshot'))
  } catch (reason) {
    throw new Error(reason instanceof Error ? `This share link could not be opened: ${reason.message}` : 'This share link could not be opened.')
  }
}

export function createShareUrl(payload: SharePayload, baseUrl: string): string {
  const url = new URL(baseUrl)
  url.search = ''
  url.hash = `${SHARE_ROUTE_PREFIX}${encodeSharePayload(payload)}`
  if (url.href.length > MAX_SHARE_URL_LENGTH) throw new Error('This snapshot is too large for a share link at this address.')
  return url.href
}

function mapRefs<T>(value: T, personalIds: ReadonlyMap<string, PersonalDefinitionId>, catalogRevisions: ReadonlyMap<string, string>): T {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(entry => mapRefs(entry, personalIds, catalogRevisions)) as T
  const entry = value as Record<string, unknown>
  if (entry.kind === 'personal' && typeof entry.definitionId === 'string') return { ...entry, definitionId: personalIds.get(entry.definitionId) ?? entry.definitionId } as T
  if (entry.kind === 'catalog' && typeof entry.catalogRevisionId === 'string') return { ...entry, catalogRevisionId: catalogRevisions.get(entry.catalogRevisionId) ?? entry.catalogRevisionId } as T
  return Object.fromEntries(Object.entries(entry).map(([key, child]) => [key, mapRefs(child, personalIds, catalogRevisions)])) as T
}

function sharedCopyDependencies(localData: LocalData, payload: SharePayload) {
  const { records } = payload
  const setupIds = new Map(Object.keys(records.gameSetups).map(id => [id, createId<GameSetupRevisionId>('gameSetupRevision')]))
  const personalIds = new Map(Object.keys(records.personalDefinitions).map(id => [id, createId<PersonalDefinitionId>('definition')]))
  const catalogRevisions = new Map([...setupIds].map(([oldId, newId]) => [modCatalogRevision(oldId as GameSetupRevisionId) as string, modCatalogRevision(newId) as string]))
  const playthrough = localData.selectedPlaythroughId ? own(localData.playthroughs, localData.selectedPlaythroughId) : undefined
  const activeSetupId = playthrough?.currentGameSetupRevisionId ?? localData.planningGameSetupRevisionId
  const candidates = Object.values(localData.gameSetups).sort((left, right) => Number(right.id === activeSetupId) - Number(left.id === activeSetupId) || right.revision - left.revision || right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id))
  const localOrigins = new Map(candidates.map(setup => [modCatalogRevision(setup.id) as string, setup]))
  const sourceOrigins = new Map(Object.values(records.gameSetups).map(setup => [modCatalogRevision(setup.id) as string, setup]))
  const localPins = [...new Set([...candidates, ...Object.values(localData.buildRevisions)].flatMap(record => Object.values(record.catalogLock)))]
  const reusedCatalogs = new Set<string>()
  for (const [pin, origin] of sourceOrigins) {
    if (!origin.modComposition) continue
    const equivalentPin = localPins.find(pin => {
      const target = localOrigins.get(pin)
      return target?.modComposition && sameCorrectionValue(origin.modComposition, target.modComposition)
    })
    if (equivalentPin) { catalogRevisions.set(pin, equivalentPin); reusedCatalogs.add(pin) }
  }
  const reusedDefinitions = new Set<string>()
  const usedDefinitions = new Set<PersonalDefinitionId>()
  const pending = new Set(Object.keys(records.personalDefinitions))
  let progressed = true
  while (pending.size && progressed) {
    progressed = false
    for (const id of pending) {
      const definition = records.personalDefinitions[id]!
      let waiting = false
      visitRefs(definitionReferences(definition), ref => { if (ref.kind === 'personal' && pending.has(ref.definitionId)) waiting = true })
      if (waiting) continue
      const mapped = { ...definition, ...mapRefs(definitionReferences(definition), personalIds, catalogRevisions) }
      const match = Object.values(localData.personalDefinitions).find(candidate => !usedDefinitions.has(candidate.id) && sameCorrectionValue({ ...mapped, id: candidate.id }, candidate))
      if (match) { personalIds.set(id, match.id); usedDefinitions.add(match.id); reusedDefinitions.add(id) }
      pending.delete(id)
      progressed = true
    }
  }
  const freshLineage = (id: PersonalDefinitionId) => {
    if (!reusedDefinitions.delete(id)) return
    personalIds.set(id, createId<PersonalDefinitionId>('definition'))
    const definition = records.personalDefinitions[id]!
    if (definition.previousRevision) freshLineage(definition.previousRevision.definitionId)
  }
  const localSuccessors = new Set(Object.values(localData.personalDefinitions).flatMap(definition => definition.previousRevision ? [definition.previousRevision.definitionId] : []))
  for (const definition of Object.values(records.personalDefinitions)) {
    if (reusedDefinitions.has(definition.id) || !definition.previousRevision) continue
    const previous = definition.previousRevision.definitionId
    if (localSuccessors.has(personalIds.get(previous)!)) freshLineage(previous)
  }
  let invalidated = true
  while (invalidated) {
    invalidated = false
    for (const id of reusedDefinitions) {
      const definition = records.personalDefinitions[id]!
      const target = localData.personalDefinitions[personalIds.get(id)!]!
      const mapped = { ...definition, ...mapRefs(definitionReferences(definition), personalIds, catalogRevisions), id: target.id }
      if (!sameCorrectionValue(mapped, target)) { freshLineage(definition.id); invalidated = true }
    }
  }
  for (const definition of Object.values(records.personalDefinitions)) {
    if (reusedDefinitions.has(definition.id) || definition.previousRevision || definition.baseRef?.kind !== 'catalog') continue
    const baseRef = mapRefs(definition.baseRef, personalIds, catalogRevisions)
    if (Object.values(localData.personalDefinitions).some(candidate => !candidate.previousRevision && sameCorrectionValue(candidate.baseRef, baseRef))) {
      throw new Error('This shared snapshot has a different personal correction for a catalog definition already corrected in this browser. Existing corrections were preserved.')
    }
  }
  const requiredSetups = new Set<GameSetupRevisionId>()
  const addSetup = (id: GameSetupRevisionId) => {
    if (requiredSetups.has(id)) return
    requiredSetups.add(id)
    for (const pin of Object.values(records.gameSetups[id]!.catalogLock)) {
      const origin = sourceOrigins.get(pin)
      if (origin && !reusedCatalogs.has(pin)) addSetup(origin.id)
    }
  }
  if (payload.teamGameSetupRevisionId) addSetup(payload.teamGameSetupRevisionId)
  for (const revision of Object.values(records.buildRevisions)) addSetup(revision.gameSetupRevisionId)
  const catalogLock = (lock: GameSetupRevision['catalogLock']) => Object.fromEntries(Object.entries(lock).map(([id, revision]) => [id, catalogRevisions.get(revision) ?? revision])) as GameSetupRevision['catalogLock']
  const setupFamilyIds = new Map<string, GameSetupId>()
  const reusedSetups = new Set<GameSetupRevisionId>()
  const sourceFamilies = new Set([...requiredSetups].map(id => records.gameSetups[id]!.gameSetupId))
  for (const family of sourceFamilies) {
    const sources = [...requiredSetups].map(id => records.gameSetups[id]!).filter(setup => setup.gameSetupId === family)
    const configurations = sources.map(setup => ({ ...mapRefs(setup, personalIds, catalogRevisions), catalogLock: catalogLock(setup.catalogLock) }))
    const targetFamilies = [...new Set(candidates.map(setup => setup.gameSetupId))]
    let matches: GameSetupRevision[] | undefined
    for (const targetFamily of targetFamilies) {
      const familyCandidates = candidates.filter(setup => setup.gameSetupId === targetFamily)
      const found = configurations.map(configuration => familyCandidates.find(setup => sameBuildBehavior(configuration, setup)))
      if (found.every(setup => setup !== undefined)) { matches = found as GameSetupRevision[]; break }
    }
    setupFamilyIds.set(family, matches ? matches[0]!.gameSetupId : createId<GameSetupId>('gameSetup'))
    if (matches) sources.forEach((setup, index) => { setupIds.set(setup.id, matches![index]!.id); reusedSetups.add(setup.id) })
  }
  return { personalIds, setupIds, setupFamilyIds, catalogRevisions, catalogLock, requiredSetups, reusedDefinitions, reusedSetups }
}

export function saveSharedCopy(localData: LocalData, input: SharePayload): { readonly localData: LocalData; readonly buildId?: BuildId; readonly teamId?: TeamId } {
  const payload = validateSharePayload(input)
  const { records } = payload
  const { personalIds, setupIds, setupFamilyIds, catalogRevisions, catalogLock, requiredSetups, reusedDefinitions, reusedSetups } = sharedCopyDependencies(localData, payload)
  const buildIds = new Map(Object.keys(records.builds).map(id => [id, createId<BuildId>('build')]))
  const revisionIds = new Map(Object.keys(records.buildRevisions).map(id => [id, createId<BuildRevisionId>('buildRevision')]))
  const personalDefinitions = { ...localData.personalDefinitions }
  for (const definition of Object.values(records.personalDefinitions)) {
    if (reusedDefinitions.has(definition.id)) continue
    const mapped = mapRefs(definitionReferences(definition), personalIds, catalogRevisions)
    const id = personalIds.get(definition.id)!
    personalDefinitions[id] = { ...definition, ...mapped, id }
  }
  const gameSetups = { ...localData.gameSetups }
  for (const setup of Object.values(records.gameSetups)) {
    if (!requiredSetups.has(setup.id) || reusedSetups.has(setup.id)) continue
    const mapped = mapRefs(setup, personalIds, catalogRevisions)
    const id = setupIds.get(setup.id)!
    gameSetups[id] = { ...mapped, id, label: uniqueGameSetupLabel(setup.label, gameSetups, 'shared'), gameSetupId: setupFamilyIds.get(setup.gameSetupId)!, catalogLock: catalogLock(setup.catalogLock) }
  }
  const builds = { ...localData.builds }
  const buildRevisions = { ...localData.buildRevisions }
  for (const build of Object.values(records.builds)) {
    const id = buildIds.get(build.id)!
    builds[id] = { ...build, id, gameSetupId: setupFamilyIds.get(build.gameSetupId)!, latestRevisionId: revisionIds.get(build.latestRevisionId!) }
  }
  for (const revision of Object.values(records.buildRevisions)) {
    const id = revisionIds.get(revision.id)!
    buildRevisions[id] = { ...revision, id, buildId: buildIds.get(revision.buildId)!, gameSetupRevisionId: setupIds.get(revision.gameSetupRevisionId)!, catalogLock: catalogLock(revision.catalogLock), content: mapRefs(revision.content, personalIds, catalogRevisions) }
  }
  const now = nowTimestamp()
  let next = updateLocalData(localData, { personalDefinitions, gameSetups, builds, buildRevisions }, 'share.saveCopy', ['personalDefinitions', 'gameSetups', 'builds', 'buildRevisions'], now)
  if (payload.kind === 'build') return { localData: next, buildId: [...buildIds.values()][0]! }
  const teamId = createId<TeamId>('team')
  next = saveTeam(next, { id: teamId, title: payload.title, slots: payload.slots!.map(id => id ? revisionIds.get(id)! : null), now, expectedRevision: next.revision })
  return { localData: next, teamId }
}
