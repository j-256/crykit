import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STARTER_CATALOG } from '../catalog'
import { BUNDLED_CATALOGS } from '../catalog/bundled'
import { createBlankProfile, createPersonalDefinition } from '../domain/profile'
import { asId } from '../domain/core'
import { observeInventory } from '../domain/inventory'
import { MAX_LONG_TEXT_LENGTH, MAX_SHORT_TEXT_LENGTH } from '../domain/limits'
import { TEAM_SIZE } from '../domain/scenarios'
import type { ImportPreview } from '../interchange/types'
import type { PersonalDefinitionId, Profile, ProfileId, RulesetId, RulesetRevisionId, ScenarioId, Timestamp } from '../domain/types'
import { previewResearchJson } from '../interchange/research'
import { inspectZip } from '../interchange/zip'
import { catalogSnapshotKey } from '../interchange/identity'
import { CrystalCompanionDatabase, setDatabaseForTests } from './database'
import {
  commitImport,
  createProfile,
  exportBackup,
  listProfiles,
  loadWorkspace,
  previewImport,
  saveProfile,
  saveProfileWithStatus,
  selectProfile,
  undoProfileWithStatus,
} from './workspace'

const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value))

describe('workspace persistence', () => {
  let database: CrystalCompanionDatabase

  beforeEach(() => {
    database = new CrystalCompanionDatabase(`test-${crypto.randomUUID()}`)
    setDatabaseForTests(database)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    setDatabaseForTests(undefined)
    await database.delete()
  })

  it('starts with a sample team and saves an advanced domain revision with optimistic locking', async () => {
    const workspace = await loadWorkspace()
    expect(Object.keys(workspace.profile.inventory)).not.toHaveLength(0)
    expect(Object.keys(workspace.profile.characters)).toHaveLength(TEAM_SIZE)

    const advanced = createPersonalDefinition(workspace.profile, {
      kind: 'item',
      name: 'Synthetic Buckler',
      now: '2026-01-02T03:04:05.000Z',
      expectedRevision: workspace.revision,
    })
    const saved = await saveProfile(advanced, workspace.revision)
    expect(saved.revision).toBe(1)
    expect(saved.changes.at(-1)?.command).toBe('personalDefinition.create')
    await expect(saveProfile(saved, 0)).rejects.toMatchObject({ code: 'revision-conflict', recoverable: true })
    expect((await loadWorkspace(saved.id)).profile.revision).toBe(1)
  })

  it('reports Undo availability from retained checkpoints instead of the profile journal', async () => {
    const workspace = await loadWorkspace()
    expect(workspace.canUndo).toBe(false)
    const saved = await saveProfile({ ...workspace.profile, label: 'Saved fixture' }, workspace.revision)
    expect((await loadWorkspace(saved.id)).canUndo).toBe(true)
    await database.history.where('profileId').equals(saved.id).delete()
    const withoutCheckpoint = await loadWorkspace(saved.id)
    expect(withoutCheckpoint.profile.changes.length).toBeGreaterThan(0)
    expect(withoutCheckpoint.canUndo).toBe(false)
  })

  it('returns retained Undo status from save and undo transactions', async () => {
    const workspace = await loadWorkspace()
    const saved = await saveProfileWithStatus({ ...workspace.profile, label: 'Saved fixture' }, workspace.revision)
    expect(saved.canUndo).toBe(true)

    const undone = await undoProfileWithStatus(saved.profile.id, saved.profile.revision)
    expect(undone.canUndo).toBe(true)
    expect(undone.profile.revision).toBe(saved.profile.revision + 1)
  })

  it('reports no Undo checkpoint when a bounded profile exceeds the history byte budget', async () => {
    const workspace = await loadWorkspace()
    const rawDescription = 'x'.repeat(MAX_LONG_TEXT_LENGTH - 1)
    const personalDefinitions = Object.fromEntries(Array.from({ length: 9 }, (_, index) => {
      const id = asId<PersonalDefinitionId>(`large-definition-${index}`)
      return [id, {
        id,
        revision: 0,
        kind: 'item' as const,
        name: `Large definition ${index}`,
        aliases: [],
        rawDescription,
        fields: {},
        sources: [],
        createdAt: workspace.profile.createdAt,
        updatedAt: workspace.profile.updatedAt,
      }]
    }))

    const saved = await saveProfileWithStatus(
      { ...workspace.profile, personalDefinitions },
      workspace.revision,
    )
    expect(saved.canUndo).toBe(false)
    expect(await database.history.where('profileId').equals(saved.profile.id).count()).toBe(0)
    expect((await loadWorkspace(saved.profile.id)).canUndo).toBe(false)
  })

  it('rejects a native-incompatible profile before changing stored state', async () => {
    const workspace = await loadWorkspace()
    const invalid = { ...workspace.profile, label: 'x'.repeat(MAX_SHORT_TEXT_LENGTH + 1) }

    await expect(saveProfileWithStatus(invalid, workspace.revision)).rejects.toMatchObject({
      code: 'schema-mismatch',
      recoverable: true,
    })
    const unchanged = await loadWorkspace(workspace.profile.id)
    expect(unchanged.profile.label).toBe(workspace.profile.label)
    expect(unchanged.revision).toBe(workspace.revision)
  })

  it('initializes one sample profile under concurrent loads and does not reseed on reload', async () => {
    const workspaces = await Promise.all(Array.from({ length: 4 }, () => loadWorkspace()))
    expect(new Set(workspaces.map((workspace) => workspace.profile.id)).size).toBe(1)
    expect(await database.profiles.count()).toBe(1)
    expect(await database.catalogs.count()).toBe(0)
    for (const workspace of workspaces) expect(workspace.profile).toEqual(workspaces[0]!.profile)
    expect(Object.keys(workspaces[0]!.profile.characters)).toHaveLength(TEAM_SIZE)
    expect((await loadWorkspace()).profile).toEqual(workspaces[0]!.profile)
    expect(await database.history.count()).toBe(0)
  })

  it('keeps explicitly created profiles blank and makes the catalog available to both profile types', async () => {
    const first = await loadWorkspace()
    const second = await createProfile('Another empty playthrough')
    for (const workspace of [first, second]) {
      expect(workspace.catalogs).toContainEqual(STARTER_CATALOG)
      expect(workspace.profile.progress).toEqual({})
      expect(workspace.profile.importReceipts).toEqual({})
      expect(workspace.revision).toBe(0)
      expect(workspace.canUndo).toBe(false)
    }
    expect(second.profile.inventory).toEqual({})
    expect(second.profile.characters).toEqual({})
    expect(second.profile.builds).toEqual({})
    expect(second.profile.scenarios).toEqual({})
    expect((await loadWorkspace()).profile).toEqual(second.profile)
    expect(await database.catalogs.count()).toBe(0)
    expect((await loadWorkspace(first.profile.id)).profile).toEqual(first.profile)
  })

  it('rolls back failed first-run initialization and retries without a partial team', async () => {
    vi.spyOn(database.meta, 'put').mockRejectedValueOnce(new DOMException('Synthetic quota failure', 'QuotaExceededError'))
    await expect(loadWorkspace()).rejects.toMatchObject({ code: 'storage-failure', recoverable: true })
    expect(await database.profiles.count()).toBe(0)
    expect(await database.meta.count()).toBe(0)
    const retried = await loadWorkspace()
    expect(Object.keys(retried.profile.characters)).toHaveLength(TEAM_SIZE)
    expect(await database.profiles.count()).toBe(1)
  })

  it('round-trips the sample team without adding another starter to the restored profile', async () => {
    const original = await loadWorkspace()
    const preview = await previewImport(await exportBackup(original.profile.id), 'sample-team.zip')
    const restored = await commitImport(preview, { mode: 'new-profile' })
    expect(restored.profile.id).not.toBe(original.profile.id)
    for (const key of ['characters', 'inventory', 'rulesets', 'builds', 'buildRevisions', 'scenarios'] as const) {
      expect(restored.profile[key]).toEqual(original.profile[key])
    }
    expect((await loadWorkspace()).profile).toEqual(restored.profile)
  })

  it('removes legacy bundled catalog copies without replacing an existing playthrough', async () => {
    const workspace = await loadWorkspace()
    const saved = await saveProfile({ ...workspace.profile, label: 'Existing playthrough' }, workspace.revision)
    await database.catalogs.bulkPut(BUNDLED_CATALOGS.map((catalog) => ({
      key: catalogSnapshotKey(catalog.id, catalog.revisionId),
      id: catalog.id,
      revisionId: catalog.revisionId,
      checksum: catalog.checksum,
      snapshot: catalog,
    })))
    expect(await database.catalogs.count()).toBe(BUNDLED_CATALOGS.length)
    const reopened = await loadWorkspace(saved.id)
    expect(reopened.profile).toEqual(saved)
    expect(reopened.catalogs).toContainEqual(STARTER_CATALOG)
    expect(reopened.canUndo).toBe(true)
    expect(await database.catalogs.count()).toBe(0)
  })

  it('backs up selected starter definitions without requiring an imported source archive', async () => {
    const workspace = await loadWorkspace()
    const item = Object.values(STARTER_CATALOG.entities).find((entity) => entity.kind === 'item')!
    const observed = observeInventory(workspace.profile, {
      ref: { kind: 'catalog', catalogId: STARTER_CATALOG.id, catalogRevisionId: STARTER_CATALOG.revisionId, entityId: item.id },
      possession: 'owned',
      quantity: { kind: 'exact', value: 1 },
    })
    const saved = await saveProfile(observed, workspace.revision)
    const backup = await exportBackup(saved.id)
    const preview = await previewImport(backup, 'starter-selection.zip')
    expect(preview.proposed.catalogs).toContainEqual(STARTER_CATALOG)
    expect(preview.proposed.profile.inventory).toEqual(saved.inventory)
    expect(preview.proposed.sources).toEqual([])
  })

  it('rejects a conflicting reserved starter revision before writing import data', async () => {
    const original = Object.values(STARTER_CATALOG.entities)[0]!
    const conflictingCatalog = {
      ...STARTER_CATALOG,
      entities: {
        ...STARTER_CATALOG.entities,
        [original.id]: { ...original, name: `${original.name} altered` },
      },
    }
    const profile = createBlankProfile({ label: 'Conflicting import' })
    const preview = {
      id: 'preview:starter-conflict',
      filename: 'starter-conflict.zip',
      detectedFormat: 'native-backup-1.0.0',
      detectedSchema: '1.0.0',
      sourceDigest: 'f'.repeat(64),
      counts: { reference: 1, personal: 1, mixed: 0, ignored: 0 },
      warnings: [],
      errors: [],
      profile: { label: profile.label, identity: profile.id },
      proposed: {
        profile,
        lineage: { rootProfileId: profile.id },
        catalogs: [conflictingCatalog],
        evidence: [],
        sources: [],
        history: [],
      },
    } satisfies ImportPreview

    await expect(commitImport(preview)).rejects.toMatchObject({ code: 'import-conflict', recoverable: true })
    expect(await database.profiles.count()).toBe(0)
    expect(await database.catalogs.count()).toBe(0)
    expect(await database.imports.count()).toBe(0)
  })

  it('lists, creates, and selects profiles without replacing existing records', async () => {
    const first = await loadWorkspace()
    const second = await createProfile('Second fixture')
    expect(second.profile.id).not.toBe(first.profile.id)
    expect(await database.profiles.count()).toBe(2)
    expect((await listProfiles()).find((profile) => profile.id === second.profile.id)?.active).toBe(true)

    const selected = await selectProfile(first.profile.id)
    expect(selected.profile.id).toBe(first.profile.id)
    const summaries = await listProfiles()
    expect(summaries.find((profile) => profile.id === first.profile.id)?.active).toBe(true)
    expect(summaries.find((profile) => profile.id === second.profile.id)?.label).toBe('Second fixture')
  })

  it('captures a transactionally consistent backup during a concurrent save', async () => {
    const workspace = await loadWorkspace()
    const draft = { ...workspace.profile, label: 'Concurrent fixture' }
    const [backup] = await Promise.all([
      exportBackup(workspace.profile.id),
      saveProfile(draft, workspace.revision),
    ])
    const preview = await previewImport(backup, 'concurrent-backup.zip')
    const revision = preview.proposed.profile.revision
    expect([0, 1]).toContain(revision)
    expect(preview.proposed.history).toHaveLength(revision)
    expect(preview.proposed.history.at(-1)?.nextRevision).toBe(revision || undefined)
  })

  it('applies the history count limit before its byte budget', async () => {
    const workspace = await createProfile('Small history fixture')
    const oversizedOldestCommand = 'x'.repeat(8 * 1024 * 1024 + 1024)
    await database.history.bulkAdd(Array.from({ length: 501 }, (_, index) => ({
      id: `history:${index.toString().padStart(4, '0')}`,
      profileId: workspace.profile.id,
      command: index === 0 ? oversizedOldestCommand : 'fixture',
      previousRevision: Math.max(0, index - 1),
      nextRevision: index,
      before: workspace.profile,
      after: workspace.profile,
      recordedAt: workspace.profile.updatedAt,
    })))

    await saveProfile({ ...workspace.profile, label: 'Trimmed fixture' }, workspace.revision)
    const retained = await database.history.where('profileId').equals(workspace.profile.id).toArray()
    expect(retained).toHaveLength(500)
    expect(retained.some((entry) => entry.command === oversizedOldestCommand)).toBe(false)
  })

  it('exports a retained dirty draft after a save failure and restores it as a fork', async () => {
    const workspace = await loadWorkspace()
    const saved = await saveProfile({ ...workspace.profile, label: 'Persisted label' }, workspace.revision)
    const dirty: Profile = { ...saved, label: 'Retained unsaved label' }
    const backup = await exportBackup(saved.id, dirty)
    const preview = await previewImport(backup, 'synthetic-backup.zip')
    expect(preview.proposed.profile.label).toBe('Retained unsaved label')
    expect(preview.proposed.history.at(-1)?.nextRevision).toBe(preview.proposed.profile.revision)
    expect(preview.proposed.history.at(-1)?.after).toEqual(preview.proposed.profile)

    const restored = await commitImport(preview)
    expect(restored.profile.id).not.toBe(saved.id)
    expect(restored.profile.label).toContain('Retained unsaved label')
    expect(restored.lineage.sourceProfileId).toBe(saved.id)
  })

  it('exports a stale retained draft above a remotely advanced persisted revision', async () => {
    const initial = await loadWorkspace()
    const staleDraft = createPersonalDefinition(initial.profile, {
      kind: 'item',
      name: 'Stale retained fact',
      now: '2026-01-02T03:04:05.000Z',
      expectedRevision: initial.revision,
    })
    const remoteOne = await saveProfile({ ...initial.profile, label: 'Remote one' }, initial.revision)
    const remoteTwo = await saveProfile({ ...remoteOne, label: 'Remote two' }, remoteOne.revision)
    await expect(saveProfile(staleDraft, initial.revision)).rejects.toMatchObject({ code: 'revision-conflict' })

    const preview = await previewImport(await exportBackup(initial.profile.id, staleDraft), 'stale-recovery.zip')
    expect(preview.proposed.profile.revision).toBe(remoteTwo.revision + 1)
    expect(preview.proposed.profile.label).toBe(initial.profile.label)
    expect(Object.values(preview.proposed.profile.personalDefinitions).map((definition) => definition.name)).toContain('Stale retained fact')
    expect(preview.proposed.history.at(-1)?.before.label).toBe('Remote two')
    expect(preview.proposed.history.at(-1)?.after).toEqual(preview.proposed.profile)

    const persisted = await loadWorkspace(initial.profile.id)
    expect(persisted.profile.revision).toBe(remoteTwo.revision)
    expect(persisted.profile.label).toBe('Remote two')
    expect(Object.values(persisted.profile.personalDefinitions)).toHaveLength(0)
  })

  it('stores over-compressible backup entries when deflate would violate import bounds', async () => {
    const workspace = await createProfile('Compressible fixture')
    const repetitiveDraft = { ...workspace.profile, label: 'x'.repeat(60_000) }
    const backup = await exportBackup(workspace.profile.id, repetitiveDraft)
    const bundle = inspectZip(backup).entries.find((entry) => entry.name === 'bundle.json')
    expect(bundle?.compression).toBe(0)
    await expect(previewImport(backup, 'repetitive-backup.zip')).resolves.toMatchObject({
      proposed: { profile: { label: repetitiveDraft.label } },
    })
  })

  it('rebases a recorded-party baseline when replacing a lower-revision profile', async () => {
    const target = await createProfile('Blank replacement target')
    const timestamp = '2026-01-02T03:04:05.000Z' as Timestamp
    const rulesetId = 'ruleset-revision:source' as RulesetRevisionId
    const scenarioId = 'scenario:source' as ScenarioId
    const sourceProfile: Profile = {
      ...structuredClone(target.profile),
      id: 'profile:source' as ProfileId,
      revision: 5,
      activeRulesetRevisionId: rulesetId,
      activeScenarioId: scenarioId,
      rulesets: {
        [rulesetId]: {
          id: rulesetId,
          rulesetId: 'ruleset:source' as RulesetId,
          revision: 1,
          label: 'Source ruleset',
          platform: { state: 'unknown' },
          gameVersion: { state: 'unknown' },
          mode: { state: 'unknown' },
          mods: { state: 'unknown' },
          ppCostsNonNegative: { state: 'unknown' },
          slots: [],
          catalogLock: {},
          createdAt: timestamp,
        },
      },
      scenarios: {
        [scenarioId]: {
          id: scenarioId,
          revision: 0,
          label: 'Recorded source',
          kind: 'recordedCurrent',
          baseline: { kind: 'recordedParty', profileRevision: 4, assignments: {} },
          assignments: {},
          rulesetRevisionId: rulesetId,
          catalogLock: {},
          inventoryPolicy: { includeProtected: true, enforceStock: true },
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      },
      changes: [],
      updatedAt: timestamp,
    }
    const preview = {
      id: 'preview:replacement',
      filename: 'replacement.zip',
      detectedFormat: 'native-backup-1.0.0',
      detectedSchema: '1.0.0',
      sourceDigest: 'a'.repeat(64),
      counts: { reference: 0, personal: 1, mixed: 0, ignored: 0 },
      warnings: [],
      errors: [],
      profile: { label: sourceProfile.label, identity: sourceProfile.id },
      proposed: {
        profile: sourceProfile,
        lineage: { rootProfileId: sourceProfile.id },
        catalogs: [],
        evidence: [],
        sources: [],
        history: [],
      },
    } satisfies ImportPreview
    const replaced = await commitImport(preview, { mode: 'replace', targetProfileId: target.profile.id, expectedRevision: target.revision })
    expect(replaced.profile.scenarios[scenarioId]?.baseline).toEqual({ kind: 'recordedParty', profileRevision: 1, assignments: {} })
    const restored = await previewImport(await exportBackup(replaced.profile.id), 'replacement-roundtrip.zip')
    expect(restored.proposed.profile.scenarios[scenarioId]?.baseline).toEqual({ kind: 'recordedParty', profileRevision: 1, assignments: {} })
  })

  it('round-trips a metadata-heavy research import and treats a repeated source as idempotent', async () => {
    const expansionItems = Array.from({ length: 600 }, (_, index) => ({
      item_id: `fixture:item:${index}`,
      name: `Fixture Item ${index}`,
      type: index % 2 === 0 ? 'Shield' : 'Accessory',
      stats_raw: `PDef ${index}; MDef ${index + 1}`,
      effects_raw: `Synthetic effect ${index}`,
      source: { row: index + 2, notes: ['generated', 'private-free'] },
    }))
    const preview = await previewResearchJson(bytes({
      schema_version: '1.1.0',
      classes: [],
      abilities: [],
      innates: [],
      passives: [],
      monster_magic: [],
      base_equipment: [],
      expansion_items: expansionItems,
      expansion_stat_components: [],
      unparsed_stat_tokens: [],
      expansion_locations: [],
      recipes: [],
      conflicts: [],
      sources: [],
      coverage: [],
      planner_rules: [],
      progress: [],
      inventory: [],
      characters: [],
      character_mastery: [],
      learned_passives: [],
      loadouts: [],
      mod_overrides: [],
      player_context: { platform: 'Synthetic handheld' },
    }), 'synthetic-research.json')
    const imported = await commitImport(preview)
    const backup = await exportBackup(imported.profile.id)
    const restoredPreview = await previewImport(backup, 'synthetic-heavy-backup.zip')
    expect(Object.keys(restoredPreview.proposed.catalogs[0]?.entities ?? {})).toHaveLength(600)

    await createProfile('Other active fixture')
    const repeated = await commitImport(preview)
    expect(repeated.profile.id).toBe(imported.profile.id)
    expect((await loadWorkspace()).profile.id).toBe(imported.profile.id)
  })

  it('retains reference-only catalogs through workspace load and backup', async () => {
    const preview = await previewResearchJson(bytes({
      schema_version: '1.1.0',
      base_equipment: [{ item_id: 'fixture:reference-only', name: 'Reference-only fixture' }],
    }), 'reference-only.json')
    const imported = await commitImport(preview)
    const loaded = await loadWorkspace(imported.profile.id)
    const restored = await previewImport(await exportBackup(imported.profile.id), 'reference-only-backup.zip')
    for (const catalogs of [imported.catalogs, loaded.catalogs, restored.proposed.catalogs]) {
      const reference = catalogs.find((catalog) => catalog.id === preview.proposed.catalogs[0]?.id)
      expect(reference?.entities['fixture:reference-only']?.name).toBe('Reference-only fixture')
    }
  })

  it('keeps historical acquisition separate from stock and retains source bytes through a fork', async () => {
    const researchBytes = bytes({
      schema_version: '1.1.0',
      expansion_items: [{ item_id: 'fixture:item:history', name: 'Historic Fixture' }],
      inventory: [{ item: 'Historic Fixture', acquired: true, quantity: null, current_possession: null }],
    })
    const preview = await previewResearchJson(researchBytes, 'history.json')
    expect(Object.keys(preview.proposed.profile.inventory)).toHaveLength(0)
    const event = Object.values(preview.proposed.profile.inventoryEvents)[0]
    expect(event?.quantity).toMatchObject({ state: 'unknown' })
    expect(event?.observedAt).toBeUndefined()

    const imported = await commitImport(preview)
    const firstBackup = await exportBackup(imported.profile.id)
    const restorePreview = await previewImport(firstBackup, 'history-backup.zip')
    expect(Array.from(restorePreview.proposed.sources[0]?.bytes ?? [])).toEqual(Array.from(researchBytes))
    const fork = await commitImport(restorePreview)
    const secondBackup = await exportBackup(fork.profile.id)
    const secondPreview = await previewImport(secondBackup, 'history-fork-backup.zip')
    expect(Array.from(secondPreview.proposed.sources[0]?.bytes ?? [])).toEqual(Array.from(researchBytes))
    expect(await database.sources.count()).toBe(1)
  })

  it('requires compare-and-swap for explicit replacement', async () => {
    const workspace = await loadWorkspace()
    const backup = await exportBackup(workspace.profile.id, { ...workspace.profile, label: 'Replacement data' })
    const preview = await previewImport(backup, 'replacement.zip')
    await expect(commitImport(preview, {
      mode: 'replace',
      targetProfileId: workspace.profile.id,
      expectedRevision: workspace.revision + 1,
    })).rejects.toMatchObject({ code: 'revision-conflict' })

    const replaced = await commitImport(preview, {
      mode: 'replace',
      targetProfileId: workspace.profile.id,
      expectedRevision: workspace.revision,
    })
    expect(replaced.profile.label).toBe('Replacement data')
    expect(replaced.profile.revision).toBe(workspace.revision + 1)
  })

  it('rolls back every store when an immutable catalog conflicts', async () => {
    const first = await previewResearchJson(bytes({
      schema_version: '1.1.0',
      classes: [{ id: 'fixture:class', name: 'Fixture One' }],
    }), 'first.json')
    await commitImport(first)
    const beforeProfiles = await database.profiles.count()
    const beforeSources = await database.sources.count()

    const second = await previewResearchJson(bytes({
      schema_version: '1.1.0',
      classes: [{ id: 'fixture:other', name: 'Fixture Two' }],
    }), 'second.json')
    const firstCatalog = first.proposed.catalogs[0]
    if (!firstCatalog) throw new Error('Expected a catalog')
    const conflicting = {
      ...second,
      proposed: {
        ...second.proposed,
        catalogs: [{ ...firstCatalog, schemaVersion: 'tampered-with-same-checksum' }],
      },
    }
    await expect(commitImport(conflicting)).rejects.toMatchObject({ code: 'import-conflict' })
    expect(await database.profiles.count()).toBe(beforeProfiles)
    expect(await database.sources.count()).toBe(beforeSources)
  })

  it('rejects source and evidence ID collisions without overwriting local records', async () => {
    const preview = await previewResearchJson(bytes({
      schema_version: '1.1.0',
      expansion_items: [{ item_id: 'fixture:item', name: 'Fixture item' }],
    }), 'collision.json')
    const source = preview.proposed.sources[0]
    const evidence = preview.proposed.evidence[0]
    if (!source || !evidence) throw new Error('Expected retained source and evidence')
    await database.sources.add({ ...source, bytes: bytes('different bytes') })
    await expect(commitImport(preview)).rejects.toMatchObject({ code: 'import-conflict' })
    expect(Array.from((await database.sources.get(source.id))?.bytes ?? [])).toEqual(Array.from(bytes('different bytes')))

    await database.sources.delete(source.id)
    await database.evidence.add({ ...evidence, locator: '/different' })
    await expect(commitImport(preview)).rejects.toMatchObject({ code: 'import-conflict' })
    expect((await database.evidence.get(evidence.id))?.locator).toBe('/different')
    expect(await database.profiles.count()).toBe(0)
  })
})
