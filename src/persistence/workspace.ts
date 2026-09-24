import { zipSync, type Zippable } from 'fflate'
import type {
  CatalogSnapshot,
  ChangeEntry,
  Profile,
  ProfileId,
  Timestamp,
} from '../domain/types'
import { AppDataError, asAppDataError } from '../interchange/errors'
import { previewImport as buildImportPreview } from '../interchange/import'
import { validateNativeProfileGraph } from '../interchange/native'
import { parseBoundedJson } from '../interchange/json'
import { catalogSnapshotKey } from '../interchange/identity'
import type {
  CommitImportOptions,
  ImportCandidate,
  ImportPreview,
  NativeBackupManifest,
  PersistedHistoryEntry,
  ProfileSummary,
  Workspace,
  WorkspaceNotification,
} from '../interchange/types'
import {
  asChangeId,
  asProfileId,
  cloneJson,
  createBlankProfile,
  nowTimestamp,
  randomId,
  sha256,
} from '../interchange/util'
import {
  type CatalogRecord,
  CrystalCompanionDatabase,
  getDatabase,
  type ProfileRecord,
} from './database'
import { DEFAULT_ARCHIVE_LIMITS, inspectZip } from '../interchange/zip'

const ACTIVE_PROFILE_KEY = 'active-profile'
const CHANNEL_NAME = 'crystal-companion-workspace'
const MAX_PROFILE_CHANGES = 500
const MAX_HISTORY_ENTRIES = 500
const MAX_HISTORY_BYTES = 8 * 1024 * 1024
const BACKUP_PAYLOAD_HEADROOM_BYTES = 1024 * 1024
const MAX_BACKUP_PAYLOAD_BYTES = DEFAULT_ARCHIVE_LIMITS.maxEntryUncompressedBytes - BACKUP_PAYLOAD_HEADROOM_BYTES

let channel: BroadcastChannel | undefined
const localListeners = new Set<(notification: WorkspaceNotification) => void>()

function broadcastChannel(): BroadcastChannel | undefined {
  if (typeof BroadcastChannel === 'undefined') return undefined
  channel ??= new BroadcastChannel(CHANNEL_NAME)
  return channel
}

function notify(notification: WorkspaceNotification): void {
  for (const listener of localListeners) listener(notification)
  broadcastChannel()?.postMessage(notification)
}

export function subscribeWorkspace(listener: (notification: WorkspaceNotification) => void): () => void {
  localListeners.add(listener)
  const remote = (event: MessageEvent<WorkspaceNotification>): void => listener(event.data)
  broadcastChannel()?.addEventListener('message', remote)
  return () => {
    localListeners.delete(listener)
    broadcastChannel()?.removeEventListener('message', remote)
  }
}

export interface ProfileWriteResult {
  readonly profile: Profile
  readonly canUndo: boolean
}

export function validateProfileForStorage(
  profile: Profile,
  catalogs: readonly CatalogSnapshot[],
): void {
  validateNativeProfileGraph(profile, catalogs)
}

function catalogKey(snapshot: CatalogSnapshot): string {
  return catalogSnapshotKey(snapshot.id, snapshot.revisionId)
}

function toCatalogRecord(snapshot: CatalogSnapshot): CatalogRecord {
  return {
    key: catalogKey(snapshot),
    id: snapshot.id,
    revisionId: snapshot.revisionId,
    checksum: snapshot.checksum,
    snapshot,
  }
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

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
}

async function assertCatalogsImmutable(
  database: CrystalCompanionDatabase,
  catalogs: readonly CatalogSnapshot[],
): Promise<void> {
  for (const catalog of catalogs) {
    const existing = await database.catalogs.get(catalogKey(catalog))
    if (existing && !jsonEqual(existing.snapshot, catalog)) {
      throw new AppDataError('import-conflict', 'A catalog revision conflicts with immutable local data', {
        recoverable: true,
        details: { catalogId: catalog.id, revisionId: catalog.revisionId },
      })
    }
  }
}

async function initializeBlankRecord(database: CrystalCompanionDatabase): Promise<ProfileRecord> {
  return database.transaction('rw', database.profiles, database.meta, async () => {
    const activeId = (await database.meta.get(ACTIVE_PROFILE_KEY))?.value
    const active = activeId ? await database.profiles.get(activeId) : undefined
    if (active) return active
    const existing = await database.profiles.orderBy('updatedAt').last()
    if (existing) {
      await database.meta.put({ key: ACTIVE_PROFILE_KEY, value: existing.id })
      return existing
    }
    const profile = createBlankProfile()
    validateProfileForStorage(profile, [])
    const record: ProfileRecord = {
      id: profile.id,
      revision: profile.revision,
      updatedAt: profile.updatedAt,
      profile,
      lineage: { rootProfileId: profile.id },
    }
    await database.profiles.add(record)
    await database.meta.put({ key: ACTIVE_PROFILE_KEY, value: profile.id })
    return record
  })
}

export async function listProfiles(): Promise<readonly ProfileSummary[]> {
  const database = getDatabase()
  try {
    return await database.transaction('r', database.profiles, database.meta, async () => {
      const active = (await database.meta.get(ACTIVE_PROFILE_KEY))?.value
      const records = await database.profiles.orderBy('updatedAt').reverse().toArray()
      return records.map((record) => ({
        id: record.profile.id,
        label: record.profile.label,
        revision: record.revision,
        updatedAt: record.updatedAt,
        lineage: cloneJson(record.lineage),
        active: record.id === active,
      }))
    })
  } catch (error) {
    throw asAppDataError(error, {
      code: 'storage-failure',
      userMessage: 'The local profile list could not be loaded',
      recoverable: true,
    })
  }
}

export async function createProfile(label = 'New playthrough'): Promise<Workspace> {
  const database = getDatabase()
  let profileId: ProfileId | undefined
  try {
    await database.transaction('rw', database.profiles, database.meta, async () => {
      const profile = createBlankProfile(label.trim() || 'New playthrough')
      validateProfileForStorage(profile, [])
      profileId = profile.id
      await database.profiles.add({
        id: profile.id,
        revision: profile.revision,
        updatedAt: profile.updatedAt,
        profile,
        lineage: { rootProfileId: profile.id },
      })
      await database.meta.put({ key: ACTIVE_PROFILE_KEY, value: profile.id })
    })
  } catch (error) {
    throw asAppDataError(error, {
      code: 'storage-failure',
      userMessage: 'A new local profile could not be created',
      recoverable: true,
    })
  }
  if (!profileId) throw new AppDataError('storage-failure', 'Profile creation did not complete', { recoverable: true })
  const workspace = await loadWorkspace(profileId)
  notify({ profileId, revision: workspace.revision, reason: 'active-profile' })
  return workspace
}

export async function selectProfile(profileId: ProfileId): Promise<Workspace> {
  const database = getDatabase()
  try {
    await database.transaction('rw', database.profiles, database.meta, async () => {
      const record = await database.profiles.get(profileId)
      if (!record) throw new AppDataError('not-found', 'The selected local profile no longer exists', { recoverable: true })
      await database.meta.put({ key: ACTIVE_PROFILE_KEY, value: profileId })
    })
  } catch (error) {
    throw asAppDataError(error, {
      code: 'storage-failure',
      userMessage: 'The selected local profile could not be opened',
      recoverable: true,
    })
  }
  const workspace = await loadWorkspace(profileId)
  notify({ profileId, revision: workspace.revision, reason: 'active-profile' })
  return workspace
}

async function resolveProfileRecord(
  database: CrystalCompanionDatabase,
  profileId?: ProfileId,
): Promise<ProfileRecord> {
  const requestedId = profileId ?? asProfileId((await database.meta.get(ACTIVE_PROFILE_KEY))?.value ?? '')
  if (requestedId) {
    const requested = await database.profiles.get(requestedId)
    if (requested) return requested
    if (profileId) {
      throw new AppDataError('not-found', 'The selected local profile no longer exists', {
        recoverable: true,
        details: { profileId },
      })
    }
  }
  const first = await database.profiles.orderBy('updatedAt').last()
  return first ?? initializeBlankRecord(database)
}

function catalogReferences(profile: Profile): Set<string> {
  const keys = new Set<string>()
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    const record = value as Readonly<Record<string, unknown>>
    if (
      record.kind === 'catalog' &&
      typeof record.catalogId === 'string' &&
      typeof record.catalogRevisionId === 'string'
    ) {
      keys.add(catalogSnapshotKey(record.catalogId, record.catalogRevisionId))
    }
    for (const nested of Object.values(record)) visit(nested)
  }
  visit(profile)
  for (const ruleset of Object.values(profile.rulesets)) {
    for (const [catalogId, revisionId] of Object.entries(ruleset.catalogLock)) {
      keys.add(catalogSnapshotKey(catalogId, revisionId))
    }
  }
  return keys
}

function profileImportDigests(profile: Profile): Set<string> {
  return new Set(
    Object.values(profile.importReceipts)
      .map((receipt) => /^sha256:([0-9a-f]{64})$/.exec(receipt.sourceIdentity)?.[1])
      .filter((digest): digest is string => Boolean(digest)),
  )
}

async function workspaceForRecord(database: CrystalCompanionDatabase, record: ProfileRecord): Promise<Workspace> {
  const keys = catalogReferences(record.profile)
  const digests = profileImportDigests(record.profile)
  const catalogRecords = (await database.catalogs.toArray()).filter(
    (candidate) => keys.has(candidate.key) || digests.has(/^sha256:([0-9a-f]{64})$/.exec(candidate.checksum)?.[1] ?? ''),
  )
  for (const catalog of catalogRecords) {
    const digest = /^sha256:(.+)$/.exec(catalog.checksum)?.[1]
    if (digest) digests.add(digest)
  }
  const evidence = digests.size > 0
    ? (await database.evidence.toArray()).filter((record) => digests.has(record.sourceDigest))
    : []
  const canUndo = Boolean(await database.history
    .where('[profileId+nextRevision]')
    .equals([record.profile.id, record.revision])
    .first())
  return {
    profile: cloneJson(record.profile),
    lineage: cloneJson(record.lineage),
    catalogs: catalogRecords.map((catalog) => cloneJson(catalog.snapshot)),
    evidence: evidence.map(cloneJson),
    revision: record.revision,
    canUndo,
  }
}

export async function loadWorkspace(profileId?: ProfileId): Promise<Workspace> {
  const database = getDatabase()
  try {
    const record = await resolveProfileRecord(database, profileId)
    return await workspaceForRecord(database, record)
  } catch (error) {
    throw asAppDataError(error, {
      code: 'storage-failure',
      userMessage: 'The local workspace could not be loaded',
      recoverable: true,
    })
  }
}

function changedProfile(before: Profile, proposed: Profile, command: string, timestamp: Timestamp): Profile {
  const nextRevision = before.revision + 1
  const change: ChangeEntry = {
    id: asChangeId(randomId('change')),
    command,
    previousRevision: before.revision,
    nextRevision,
    changedPaths: ['$'],
    recordedAt: timestamp,
  }
  return {
    ...cloneJson(proposed),
    id: before.id,
    revision: nextRevision,
    createdAt: before.createdAt,
    updatedAt: timestamp,
    changes: [...before.changes, change].slice(-MAX_PROFILE_CHANGES),
  }
}

function profileForSave(before: Profile, proposed: Profile, expectedRevision: number, timestamp: Timestamp): {
  readonly profile: Profile
  readonly command: string
} {
  if (proposed.id !== before.id || proposed.revision < expectedRevision) {
    throw new AppDataError('revision-conflict', 'The draft does not descend from the loaded profile revision', {
      recoverable: true,
    })
  }
  if (proposed.revision === expectedRevision) {
    return { profile: changedProfile(before, proposed, 'save-profile', timestamp), command: 'save-profile' }
  }
  const retainedIds = new Set(before.changes.map((change) => change.id))
  const newChanges = proposed.changes.filter((change) => !retainedIds.has(change.id))
  const lastChange = newChanges.at(-1)
  if (newChanges.length === 0 || lastChange?.nextRevision !== proposed.revision) {
    throw new AppDataError('schema-mismatch', 'The draft revision is missing its domain change history', {
      recoverable: true,
    })
  }
  const command = newChanges.map((change) => change.command).join('+')
  return {
    profile: {
      ...cloneJson(proposed),
      id: before.id,
      createdAt: before.createdAt,
      updatedAt: timestamp,
      changes: proposed.changes.slice(-MAX_PROFILE_CHANGES),
    },
    command,
  }
}

function historyEntry(before: Profile, after: Profile, command: string, timestamp: Timestamp): PersistedHistoryEntry {
  return {
    id: randomId('history'),
    profileId: before.id,
    command,
    previousRevision: before.revision,
    nextRevision: after.revision,
    before: cloneJson(before),
    after: cloneJson(after),
    recordedAt: timestamp,
  }
}

async function trimHistory(database: CrystalCompanionDatabase, profileId: ProfileId): Promise<boolean> {
  const entries = await database.history.where('profileId').equals(profileId).sortBy('nextRevision')
  let removeCount = Math.max(0, entries.length - MAX_HISTORY_ENTRIES)
  let retainedBytes = entries.slice(removeCount).reduce((total, entry) => total + textBytes(entry).byteLength, 0)
  while (removeCount < entries.length && retainedBytes > MAX_HISTORY_BYTES) {
    retainedBytes -= textBytes(entries[removeCount]).byteLength
    removeCount += 1
  }
  if (removeCount > 0) await database.history.bulkDelete(entries.slice(0, removeCount).map((entry) => entry.id))
  return removeCount < entries.length
}

async function storedCatalogsForProfile(
  database: CrystalCompanionDatabase,
  profile: Profile,
): Promise<readonly CatalogSnapshot[]> {
  const keys = catalogReferences(profile)
  return (await database.catalogs.toArray())
    .filter((record) => keys.has(record.key))
    .map((record) => record.snapshot)
}

export async function saveProfileWithStatus(profile: Profile, expectedRevision: number): Promise<ProfileWriteResult> {
  const database = getDatabase()
  let result: ProfileWriteResult | undefined
  try {
    await database.transaction('rw', database.profiles, database.history, database.catalogs, async () => {
      const record = await database.profiles.get(profile.id)
      if (!record) throw new AppDataError('not-found', 'The profile no longer exists', { recoverable: true })
      if (record.revision !== expectedRevision) {
        throw new AppDataError('revision-conflict', 'This profile changed in another tab. Reload before saving', {
          recoverable: true,
          details: { expectedRevision, actualRevision: record.revision },
        })
      }
      const timestamp = nowTimestamp()
      const prepared = profileForSave(record.profile, profile, expectedRevision, timestamp)
      const saved = prepared.profile
      validateProfileForStorage(saved, await storedCatalogsForProfile(database, saved))
      await database.profiles.put({
        ...record,
        revision: saved.revision,
        updatedAt: saved.updatedAt,
        profile: saved,
      })
      await database.history.add(historyEntry(record.profile, saved, prepared.command, timestamp))
      result = { profile: saved, canUndo: await trimHistory(database, saved.id) }
    })
  } catch (error) {
    throw asAppDataError(error, {
      code: 'storage-failure',
      userMessage: 'The profile could not be saved. Your previous local revision is unchanged',
      recoverable: true,
    })
  }
  if (!result) throw new AppDataError('storage-failure', 'The profile save did not complete', { recoverable: true })
  notify({ profileId: result.profile.id, revision: result.profile.revision, reason: 'save' })
  return cloneJson(result)
}

export async function saveProfile(profile: Profile, expectedRevision: number): Promise<Profile> {
  return (await saveProfileWithStatus(profile, expectedRevision)).profile
}

function forkCandidate(candidate: ImportCandidate, existing: boolean): ImportCandidate {
  if (!existing) return candidate
  const forkedAt = nowTimestamp()
  const profileId = asProfileId(randomId('profile'))
  const baseProfile: Profile = {
    ...cloneJson(candidate.profile),
    id: profileId,
  }
  const rewrittenHistory = candidate.history.map((entry) => ({
    ...entry,
    id: randomId('history'),
    profileId,
    before: { ...cloneJson(entry.before), id: profileId },
    after: { ...cloneJson(entry.after), id: profileId },
  }))
  const profile = changedProfile(baseProfile, {
    ...baseProfile,
    label: `${candidate.profile.label} (imported copy)`,
  }, 'fork-imported-profile', forkedAt)
  const history = [
    ...rewrittenHistory,
    historyEntry(baseProfile, profile, 'fork-imported-profile', forkedAt),
  ].slice(-MAX_HISTORY_ENTRIES)
  return {
    ...candidate,
    profile,
    lineage: {
      rootProfileId: candidate.lineage.rootProfileId,
      parentProfileId: candidate.profile.id,
      sourceProfileId: candidate.profile.id,
      sourceRevision: candidate.profile.revision,
      forkedAt,
    },
    history,
  }
}

function rebaseRecordedBaselines(profile: Profile, profileRevision: number): Profile {
  return {
    ...profile,
    scenarios: Object.fromEntries(Object.entries(profile.scenarios).map(([id, scenario]) => [id, {
      ...scenario,
      baseline: scenario.baseline.kind === 'recordedParty'
        ? { ...scenario.baseline, profileRevision }
        : scenario.baseline,
    }])),
  }
}

async function putCandidateData(database: CrystalCompanionDatabase, candidate: ImportCandidate): Promise<void> {
  await assertCatalogsImmutable(database, candidate.catalogs)
  await database.catalogs.bulkPut(candidate.catalogs.map(toCatalogRecord))
  for (const evidence of candidate.evidence) {
    const existingEvidence = await database.evidence.get(evidence.id)
    if (existingEvidence && !jsonEqual(existingEvidence, evidence)) {
      throw new AppDataError('import-conflict', 'An evidence record conflicts with existing local data', {
        recoverable: true,
        details: { evidenceId: evidence.id },
      })
    }
    if (!existingEvidence) await database.evidence.add(cloneJson(evidence))
  }
  for (const source of candidate.sources) {
    const existingSource = await database.sources.get(source.id)
    const sourceMetadata = ({ bytes: _bytes, ...metadata }: typeof source): Omit<typeof source, 'bytes'> => metadata
    if (existingSource && (
      !jsonEqual(sourceMetadata(existingSource), sourceMetadata(source)) ||
      !bytesEqual(existingSource.bytes, source.bytes)
    )) {
      throw new AppDataError('import-conflict', 'A source archive conflicts with existing local data', {
        recoverable: true,
        details: { sourceId: source.id },
      })
    }
    if (!existingSource) await database.sources.add(cloneJson(source))
  }
}

export async function commitImport(
  preview: ImportPreview,
  options: CommitImportOptions = {},
): Promise<Workspace> {
  if (preview.errors.length > 0) {
    throw new AppDataError('schema-mismatch', 'The import preview contains errors and cannot be applied', {
      recoverable: true,
    })
  }
  const database = getDatabase()
  const mode = options.mode ?? 'new-profile'
  if (mode === 'merge') {
    throw new AppDataError('import-conflict', 'Automatic profile merge is not supported. Import a separate branch for review', {
      recoverable: true,
    })
  }
  let committedId: ProfileId | undefined
  try {
    await database.transaction(
      'rw',
      [
        database.profiles,
        database.catalogs,
        database.evidence,
        database.sources,
        database.history,
        database.imports,
        database.meta,
      ],
      async () => {
        if (mode === 'new-profile') {
          const repeatedImport = await database.imports.where('sourceDigest').equals(preview.sourceDigest).first()
          if (repeatedImport) {
            await database.meta.put({ key: ACTIVE_PROFILE_KEY, value: repeatedImport.profileId })
            committedId = repeatedImport.profileId
            return
          }
          const exists = Boolean(await database.profiles.get(preview.proposed.profile.id))
          const candidate = forkCandidate(preview.proposed, exists)
          validateNativeProfileGraph(candidate.profile, candidate.catalogs, candidate.history)
          await putCandidateData(database, candidate)
          const profileRecord: ProfileRecord = {
            id: candidate.profile.id,
            revision: candidate.profile.revision,
            updatedAt: candidate.profile.updatedAt,
            profile: cloneJson(candidate.profile),
            lineage: cloneJson(candidate.lineage),
          }
          await database.profiles.add(profileRecord)
          const importedHistory = candidate.history.slice(-MAX_HISTORY_ENTRIES)
          if (importedHistory.length > 0) {
            await database.history.bulkAdd(importedHistory.map((entry) => cloneJson(entry)))
          }
          await database.imports.put({
            id: preview.id,
            sourceDigest: preview.sourceDigest,
            profileId: candidate.profile.id,
            importedAt: nowTimestamp(),
          })
          await database.meta.put({ key: ACTIVE_PROFILE_KEY, value: candidate.profile.id })
          committedId = candidate.profile.id
          return
        }

        const targetId = options.targetProfileId
        if (!targetId || options.expectedRevision === undefined) {
          throw new AppDataError('revision-conflict', 'Explicit replacement requires a target and expected revision', {
            recoverable: true,
          })
        }
        const target = await database.profiles.get(targetId)
        if (!target) throw new AppDataError('not-found', 'The replacement target no longer exists', { recoverable: true })
        if (target.revision !== options.expectedRevision) {
          throw new AppDataError('revision-conflict', 'The replacement target changed. Reload before importing', {
            recoverable: true,
            details: { expectedRevision: options.expectedRevision, actualRevision: target.revision },
          })
        }
        const timestamp = nowTimestamp()
        const proposed = rebaseRecordedBaselines(
          { ...cloneJson(preview.proposed.profile), id: targetId },
          target.revision + 1,
        )
        const replacement = changedProfile(
          target.profile,
          proposed,
          'replace-profile-from-import',
          timestamp,
        )
        validateNativeProfileGraph(replacement, preview.proposed.catalogs)
        await putCandidateData(database, preview.proposed)
        await database.profiles.put({
          id: targetId,
          revision: replacement.revision,
          updatedAt: replacement.updatedAt,
          profile: replacement,
          lineage: {
            rootProfileId: target.lineage.rootProfileId,
            parentProfileId: targetId,
            sourceProfileId: preview.proposed.profile.id,
            sourceRevision: preview.proposed.profile.revision,
            forkedAt: timestamp,
          },
        })
        await database.history.add(historyEntry(target.profile, replacement, 'replace-profile-from-import', timestamp))
        await database.imports.put({
          id: preview.id,
          sourceDigest: preview.sourceDigest,
          profileId: targetId,
          importedAt: timestamp,
        })
        await database.meta.put({ key: ACTIVE_PROFILE_KEY, value: targetId })
        committedId = targetId
      },
    )
  } catch (error) {
    throw asAppDataError(error, {
      code: 'storage-failure',
      userMessage: 'The import could not be applied. Existing local data is unchanged',
      recoverable: true,
    })
  }
  if (!committedId) throw new AppDataError('storage-failure', 'The import did not complete', { recoverable: true })
  const workspace = await loadWorkspace(committedId)
  notify({ profileId: workspace.profile.id, revision: workspace.revision, reason: 'import' })
  return workspace
}

export async function undoProfileWithStatus(profileId: ProfileId, expectedRevision: number): Promise<ProfileWriteResult> {
  const database = getDatabase()
  let result: ProfileWriteResult | undefined
  try {
    await database.transaction('rw', database.profiles, database.history, database.catalogs, async () => {
      const record = await database.profiles.get(profileId)
      if (!record) throw new AppDataError('not-found', 'The profile no longer exists', { recoverable: true })
      if (record.revision !== expectedRevision) {
        throw new AppDataError('revision-conflict', 'This profile changed in another tab. Reload before undoing', {
          recoverable: true,
        })
      }
      const latest = await database.history
        .where('[profileId+nextRevision]')
        .equals([profileId, expectedRevision])
        .last()
      if (!latest) throw new AppDataError('not-found', 'There is no saved change to undo', { recoverable: true })
      const timestamp = nowTimestamp()
      const restored = changedProfile(record.profile, latest.before, `undo:${latest.command}`, timestamp)
      validateProfileForStorage(restored, await storedCatalogsForProfile(database, restored))
      await database.profiles.put({
        ...record,
        revision: restored.revision,
        updatedAt: restored.updatedAt,
        profile: restored,
      })
      await database.history.add(historyEntry(record.profile, restored, `undo:${latest.command}`, timestamp))
      result = { profile: restored, canUndo: await trimHistory(database, restored.id) }
    })
  } catch (error) {
    throw asAppDataError(error, {
      code: 'storage-failure',
      userMessage: 'The last change could not be undone. Existing local data is unchanged',
      recoverable: true,
    })
  }
  if (!result) throw new AppDataError('storage-failure', 'Undo did not complete', { recoverable: true })
  notify({ profileId: result.profile.id, revision: result.profile.revision, reason: 'undo' })
  return cloneJson(result)
}

export async function undoProfile(profileId: ProfileId, expectedRevision: number): Promise<Profile> {
  return (await undoProfileWithStatus(profileId, expectedRevision)).profile
}

function textBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}

function zipReadableByImporter(entries: Readonly<Record<string, Uint8Array>>): Uint8Array {
  const compressed = zipSync(entries)
  const directory = inspectZip(compressed, {
    ...DEFAULT_ARCHIVE_LIMITS,
    maxCompressedBytes: DEFAULT_ARCHIVE_LIMITS.maxTotalUncompressedBytes + BACKUP_PAYLOAD_HEADROOM_BYTES,
    maxInflationRatio: Number.POSITIVE_INFINITY,
  })
  const storedPaths = new Set(directory.entries
    .filter((entry) => entry.uncompressedSize > 0 && entry.uncompressedSize / entry.compressedSize > DEFAULT_ARCHIVE_LIMITS.maxInflationRatio)
    .map((entry) => entry.name))
  if (storedPaths.size === 0) return compressed
  const adjusted = Object.fromEntries(Object.entries(entries).map(([path, bytes]) => [
    path,
    storedPaths.has(path) ? [bytes, { level: 0 }] : bytes,
  ])) as Zippable
  return zipSync(adjusted)
}

function referencedSourceDigests(...values: readonly unknown[]): ReadonlySet<string> {
  const digests = new Set<string>()
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      const digest = /^(?:source:)?sha256:([0-9a-f]{64})$/.exec(value)?.[1]
      if (digest) digests.add(digest)
      return
    }
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry)
      return
    }
    for (const entry of Object.values(value as Readonly<Record<string, unknown>>)) visit(entry)
  }
  for (const value of values) visit(value)
  return digests
}

export async function exportBackup(profileId: ProfileId, profileOverride?: Profile): Promise<Uint8Array> {
  const database = getDatabase()
  try {
    const captured = await database.transaction(
      'r',
      database.profiles,
      database.catalogs,
      database.evidence,
      database.sources,
      database.history,
      async () => {
        const record = await database.profiles.get(profileId)
        if (!record) throw new AppDataError('not-found', 'The profile no longer exists', { recoverable: true })
        if (profileOverride && profileOverride.id !== profileId) {
          throw new AppDataError('schema-mismatch', 'The recovery draft belongs to a different profile', {
            recoverable: true,
          })
        }
        let profile = cloneJson(record.profile)
        const history = (await database.history.where('profileId').equals(profileId).sortBy('nextRevision')).map(cloneJson)
        if (profileOverride && !jsonEqual(profileOverride, record.profile)) {
          const timestamp = nowTimestamp()
          const recoveryDraft = rebaseRecordedBaselines(
            { ...cloneJson(profileOverride), id: record.profile.id },
            record.revision + 1,
          )
          profile = changedProfile(record.profile, recoveryDraft, 'recovery-draft-export', timestamp)
          history.push(historyEntry(record.profile, profile, 'recovery-draft-export', timestamp))
        }
        return {
          profile,
          lineage: cloneJson(record.lineage),
          history,
          catalogRecords: await database.catalogs.toArray(),
          evidenceRecords: await database.evidence.toArray(),
          sourceRecords: await database.sources.toArray(),
        }
      },
    )
    const payloadFor = (history: readonly PersistedHistoryEntry[]) => {
      const profile = history.length === 0 && captured.profile.changes.length > 0
        ? { ...captured.profile, changes: [] }
        : captured.profile
      const catalogKeys = catalogReferences(profile)
      const importDigests = profileImportDigests(profile)
      for (const entry of history) {
        for (const key of catalogReferences(entry.before)) catalogKeys.add(key)
        for (const key of catalogReferences(entry.after)) catalogKeys.add(key)
        for (const digest of profileImportDigests(entry.before)) importDigests.add(digest)
        for (const digest of profileImportDigests(entry.after)) importDigests.add(digest)
      }
      const catalogs = captured.catalogRecords
        .filter((record) => (
          catalogKeys.has(record.key) ||
          importDigests.has(/^sha256:([0-9a-f]{64})$/.exec(record.checksum)?.[1] ?? '')
        ))
        .map((record) => cloneJson(record.snapshot))
      const availableCatalogKeys = new Set(catalogs.map((catalog) => catalogKey(catalog)))
      if (Array.from(catalogKeys).some((key) => !availableCatalogKeys.has(key))) {
        throw new AppDataError('storage-failure', 'A profile references catalog data that is missing locally', {
          recoverable: true,
        })
      }
      const digests = referencedSourceDigests(profile, history, catalogs)
      const evidence = captured.evidenceRecords.filter((record) => digests.has(record.sourceDigest)).map(cloneJson)
      const evidenceDigests = new Set(evidence.map((record) => record.sourceDigest))
      const sources = captured.sourceRecords.filter((source) => digests.has(source.digest) || evidenceDigests.has(source.digest))
      const sourceDigests = new Set(sources.map((source) => source.digest))
      const missingSourceDigest = Array.from(digests).find((digest) => !sourceDigests.has(digest))
      if (missingSourceDigest) {
        throw new AppDataError('storage-failure', 'A profile references source bytes that are missing locally', {
          recoverable: true,
          details: { sourceDigest: missingSourceDigest },
        })
      }
      const missingEvidenceSource = evidence.find((record) => !sourceDigests.has(record.sourceDigest))
      if (missingEvidenceSource) {
        throw new AppDataError('storage-failure', 'Retained evidence references source bytes that are missing locally', {
          recoverable: true,
          details: { evidenceId: missingEvidenceSource.id },
        })
      }
      return {
        payload: {
          profile,
          lineage: captured.lineage,
          catalogs,
          evidence,
          history,
        },
        sources,
      }
    }
    let retainedHistory = [...captured.history]
    let backupContent = payloadFor(retainedHistory)
    let payloadBytes = textBytes(backupContent.payload)
    while (payloadBytes.byteLength > MAX_BACKUP_PAYLOAD_BYTES && retainedHistory.length > 0) {
      retainedHistory = retainedHistory.slice(1)
      backupContent = payloadFor(retainedHistory)
      payloadBytes = textBytes(backupContent.payload)
    }
    if (payloadBytes.byteLength > MAX_BACKUP_PAYLOAD_BYTES) {
      throw new AppDataError('storage-failure', 'The current profile data exceeds the safe backup size limit', {
        recoverable: true,
        details: { limit: MAX_BACKUP_PAYLOAD_BYTES },
      })
    }
    const { sources } = backupContent
    const sourceEntries: Record<string, Uint8Array> = {}
    const sourceManifest = sources.map((source, index) => {
      const path = `sources/${index.toString().padStart(4, '0')}.bin`
      sourceEntries[path] = Uint8Array.from(source.bytes)
      return {
        id: source.id,
        digest: source.digest,
        filename: source.filename,
        mediaType: source.mediaType,
        format: source.format,
        importedAt: source.importedAt,
        path,
        size: source.bytes.byteLength,
      }
    })
    const exportedAt = nowTimestamp()
    const manifest: NativeBackupManifest = {
      format: 'crystal-companion-backup',
      formatVersion: '1.0.0',
      exportedAt,
      payload: 'bundle.json',
      sources: sourceManifest,
      history: {
        stored: captured.history.length,
        exported: retainedHistory.length,
        truncated: retainedHistory.length !== captured.history.length,
      },
    }
    const manifestBytes = textBytes(manifest)
    parseBoundedJson(manifestBytes, 'generated backup manifest')
    parseBoundedJson(payloadBytes, 'generated backup payload')
    const backup = zipReadableByImporter({
      'manifest.json': manifestBytes,
      'bundle.json': payloadBytes,
      ...sourceEntries,
    })
    inspectZip(backup)
    await buildImportPreview(backup, 'generated-native-backup.zip')
    return backup
  } catch (error) {
    throw asAppDataError(error, {
      code: 'storage-failure',
      userMessage: 'The local backup could not be created',
      recoverable: true,
    })
  }
}

export async function previewImport(bytes: Uint8Array, filename: string): Promise<ImportPreview> {
  return buildImportPreview(bytes, filename)
}

export async function sourceDigest(bytes: Uint8Array): Promise<string> {
  return sha256(bytes)
}
