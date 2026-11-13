import { LAUNCH_DATA_GENERATION } from '../domain/data-generation'
import { zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { requirePlaythrough } from '../domain'
import { addTestCharacter, createTestLocalData } from '../domain/test-helpers'
import { isImmutableCatalogSnapshot, previewNativeBackup } from './native'
import { GUIDE_CATALOG } from '../catalog/bundled'
import { catalogSnapshotKey } from './identity'
import { NativeLocalDataSchema, StoredNativeLocalDataSchema } from './native-schema'

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value))

describe('complete source backup payloads', () => {
  it('retains deeply immutable admitted catalogs without trusting altered archive contents', async () => {
    const bytes = nativeFixture({ mutatePayload: payload => { payload.catalogs = [GUIDE_CATALOG] } })
    const preview = await previewNativeBackup(bytes, 'complete.zip')
    const catalog = preview.proposed.catalogs[0]!
    expect(isImmutableCatalogSnapshot(catalog)).toBe(true)
    const entity = Object.values(catalog.entities)[0]!
    expect(Object.isFrozen(entity)).toBe(true)
    expect(Object.isFrozen(entity.sources)).toBe(true)
    expect(() => { (entity as { name: string }).name = 'Altered guide' }).toThrow()

    const changed = structuredClone(GUIDE_CATALOG)
    const changedEntity = Object.values(changed.entities)[0]! as { name: string }
    changedEntity.name = 'Altered guide'
    await expect(previewNativeBackup(nativeFixture({ mutatePayload: payload => { payload.catalogs = [changed] } }), 'changed.zip')).rejects.toThrow(/invalid identity, revision, or contents/)
    const malformed = structuredClone(GUIDE_CATALOG) as unknown as { entities: Record<string, { sources: unknown }> }
    Object.values(malformed.entities)[0]!.sources = 'Invalid provenance'
    await expect(previewNativeBackup(nativeFixture({ mutatePayload: payload => { payload.catalogs = [malformed] } }), 'malformed.zip')).rejects.toThrow(/unsupported shape/)
  })
  it('rejects prelaunch package-only manifests and requires complete source bodies', async () => {
    const pin = { id: GUIDE_CATALOG.id, revisionId: GUIDE_CATALOG.revisionId, checksum: GUIDE_CATALOG.checksum }
    for (const version of ['2.0.0', '2.1.0']) await expect(previewNativeBackup(nativeFixture({ version }), 'prelaunch.zip')).rejects.toThrow(/unsupported version/)
    await expect(previewNativeBackup(nativeFixture({ mutatePayload: payload => { payload.bundledCatalogs = [pin] } }), 'pins.zip')).rejects.toThrow()
    const preview = await previewNativeBackup(nativeFixture({ mutatePayload: payload => { payload.catalogs = [GUIDE_CATALOG] } }), 'complete.zip')
    expect(preview.detectedFormat).toBe('native-backup-3.0.0')
    expect(preview.proposed.catalogs).toEqual([GUIDE_CATALOG])
  })
})

function selectedPlaythroughRecord(localData: Record<string, unknown>): Record<string, unknown> {
  const selectedPlaythroughId = localData.selectedPlaythroughId
  const playthroughs = localData.playthroughs as Record<string, Record<string, unknown>>
  return playthroughs[String(selectedPlaythroughId)]!
}

function nativeFixture(options: {
  readonly version?: string
  readonly activeScenarioId?: string
  readonly includeBadSource?: boolean
  readonly mutateLocalData?: (localData: Record<string, unknown>) => void
  readonly mutatePayload?: (payload: Record<string, unknown>) => void
} = {}): Uint8Array {
  const sourceLocalData = createTestLocalData()
  const localData = { ...sourceLocalData, id: 'localData:synthetic' as typeof sourceLocalData.id, changes: [] }
  const mutatedLocalData = structuredClone(
    localData,
  ) as unknown as Record<string, unknown>
  if (options.activeScenarioId) selectedPlaythroughRecord(mutatedLocalData).activeScenarioId = options.activeScenarioId
  options.mutateLocalData?.(mutatedLocalData)
  const source = new TextEncoder().encode('synthetic source')
  const sources = options.includeBadSource
    ? [{
        id: 'source:synthetic',
        digest: '0'.repeat(64),
        filename: 'source.txt',
        mediaType: 'text/plain',
        format: 'research-json-1.1.0',
        importedAt: '2026-01-02T03:04:05.000Z',
        path: 'sources/0000.bin',
        size: source.byteLength,
      }]
    : []
  const manifest = {
    format: 'crykit-backup',
    formatVersion: options.version ?? '3.0.0',
    dataGeneration: LAUNCH_DATA_GENERATION,
    exportedAt: '2026-01-02T03:04:05.000Z',
    payload: 'bundle.json',
    sources,
  }
  const payload = {
    localData: mutatedLocalData,
    lineage: { rootLocalDataId: localData.id },
    catalogs: [],
    evidence: [],
    history: [],
  }
  options.mutatePayload?.(payload)
  return zipSync({
    'manifest.json': encode(manifest),
    'bundle.json': encode(payload),
    ...(options.includeBadSource ? { 'sources/0000.bin': source } : {}),
  })
}

describe('native backup validation', () => {
  it.each([undefined, { version: 1, selection: { state: 'unknown', reason: 'Synthetic missing difficulty' } }])('preserves unrecorded difficulty in a supported backup: %j', async difficulty => {
    const preview = await previewNativeBackup(nativeFixture({ mutateLocalData: data => {
      for (const setup of Object.values(data.gameSetups as Record<string, Record<string, unknown>>)) {
        if (difficulty === undefined) delete setup.difficulty
        else setup.difficulty = difficulty
      }
    } }), 'synthetic-legacy-difficulty.zip')
    for (const setup of Object.values(preview.proposed.localData.gameSetups)) expect(setup.difficulty).toEqual(difficulty)
  })

  it.each(['2.0.0', '2.1.0', '2.2.0', '2.3.0', '2.4.0', '2.5.0'])('rejects prelaunch planner schema %s without conversion', async schemaVersion => {
    const old = { ...createTestLocalData(), schemaVersion }
    expect(StoredNativeLocalDataSchema.safeParse(old).success).toBe(false)
    expect(NativeLocalDataSchema.safeParse(old).success).toBe(false)
    await expect(previewNativeBackup(nativeFixture({ mutateLocalData: data => { data.schemaVersion = schemaVersion } }), 'prelaunch.zip')).rejects.toThrow()
  })

  it('accepts legacy snapshot context and retains pinned context while rejecting dangling gameSetups', async () => {
    const pinned = addTestCharacter(createTestLocalData(), 'synthetic')
    const pinnedPlaythrough = requirePlaythrough(pinned)
    const character = Object.values(pinnedPlaythrough.characters)[0]!
    const snapshot = character.snapshots[character.currentSnapshotId!]!
    const fixture = (gameSetupRevisionId: string | undefined) => nativeFixture({ mutateLocalData: (localData) => {
      Object.assign(localData, { ...pinned, changes: [] })
      const playthrough = selectedPlaythroughRecord(localData)
      playthrough.characters = { [character.id]: { ...character, snapshots: { [snapshot.id]: { ...snapshot, gameSetupRevisionId } } } }
    } })
    const imported = await previewNativeBackup(fixture(snapshot.gameSetupRevisionId), 'pinned.zip')
    expect(requirePlaythrough(imported.proposed.localData).characters[character.id]?.snapshots[snapshot.id]?.gameSetupRevisionId).toBe(snapshot.gameSetupRevisionId)
    const legacy = await previewNativeBackup(fixture(undefined), 'legacy.zip')
    expect(requirePlaythrough(legacy.proposed.localData).characters[character.id]?.snapshots[snapshot.id]).not.toHaveProperty('gameSetupRevisionId')
    await expect(previewNativeBackup(fixture('missing'), 'missing.zip')).rejects.toMatchObject({ code: 'schema-mismatch' })
  })

  it('uses collision-safe catalog revision tuple keys', () => {
    expect(catalogSnapshotKey('a\u0000b', 'c')).not.toBe(catalogSnapshotKey('a', 'b\u0000c'))
  })

  it('rejects unknown backup format versions before applying data', async () => {
    await expect(previewNativeBackup(nativeFixture({ version: '4.0.0' }), 'future.zip')).rejects.toMatchObject({
      code: 'schema-mismatch',
    })
  })

  it('rejects broken localData graph references', async () => {
    await expect(previewNativeBackup(nativeFixture({ activeScenarioId: 'missing' }), 'broken.zip')).rejects.toMatchObject({
      code: 'schema-mismatch',
    })
  })

  it('checks every retained source against its manifest digest', async () => {
    await expect(previewNativeBackup(nativeFixture({ includeBadSource: true }), 'bad-source.zip')).rejects.toMatchObject({
      code: 'schema-mismatch',
    })
  })

  it('rejects history that does not end at the exact exported localData', async () => {
    const archive = nativeFixture({
      mutatePayload: (payload) => {
        const localData = payload.localData as Record<string, unknown>
        const before = structuredClone(localData) as Record<string, unknown>
        const after = { ...structuredClone(localData), revision: 1, label: 'Older checkpoint' }
        localData.revision = 2
        payload.history = [{
          id: 'history:one',
          localDataId: localData.id,
          command: 'fixture',
          previousRevision: 0,
          nextRevision: 1,
          before,
          after,
          recordedAt: '2026-01-02T03:04:05.000Z',
        }]
      },
    })
    await expect(previewNativeBackup(archive, 'disconnected-history.zip')).rejects.toMatchObject({ code: 'schema-mismatch' })
  })

  it('accepts date-only observations, signed costs, and finite raw source numbers', async () => {
    const archive = nativeFixture({
      mutateLocalData: (localData) => {
        localData.personalDefinitions = {
          fixture: {
            id: 'fixture',
            revision: 0,
            kind: 'item',
            name: 'Fixture',
            aliases: [],
            fields: { raw: { state: 'known', value: 1e100 } },
            ppCost: { state: 'known', value: -2 },
            sources: [{ sourceId: 'source:fixture', checkedAt: '2026-01-02' }],
            createdAt: '2026-01-02T03:04:05.000Z',
            updatedAt: '2026-01-02T03:04:05.000Z',
          },
        }
        selectedPlaythroughRecord(localData).inventory = {
          fixture: {
            id: 'fixture',
            revision: 0,
            ref: { kind: 'personal', definitionId: 'fixture' },
            possession: 'owned',
            quantity: { kind: 'exact', value: 1 },
            favorite: false,
            protectedQuantity: 0,
            wishlist: false,
            observedAt: '2026-01-02',
            sources: [],
            updatedAt: '2026-01-02T03:04:05.000Z',
          },
        }
      },
    })
    const preview = await previewNativeBackup(archive, 'supported-values.zip')
    expect(requirePlaythrough(preview.proposed.localData).inventory.fixture?.observedAt).toBe('2026-01-02')
  })

  it('retains immutable personal definition lineage while accepting old standalone definitions', async () => {
    const archive = nativeFixture({
      mutateLocalData: (localData) => {
        localData.personalDefinitions = {
          original: {
            id: 'original',
            revision: 0,
            kind: 'item',
            name: 'Original',
            aliases: [],
            fields: {},
            sources: [],
            createdAt: '2026-01-02T03:04:05.000Z',
            updatedAt: '2026-01-02T03:04:05.000Z',
          },
          revised: {
            id: 'revised',
            revision: 1,
            baseRef: { kind: 'personal', definitionId: 'original' },
            previousRevision: { kind: 'personal', definitionId: 'original' },
            kind: 'item',
            name: 'Revised',
            aliases: [],
            fields: {},
            sources: [],
            createdAt: '2026-01-03T03:04:05.000Z',
            updatedAt: '2026-01-03T03:04:05.000Z',
          },
        }
      },
    })

    await expect(previewNativeBackup(archive, 'lineage.zip')).resolves.toMatchObject({
      proposed: {
        localData: {
          personalDefinitions: {
            original: { revision: 0 },
            revised: {
              baseRef: { kind: 'personal', definitionId: 'original' },
              previousRevision: { kind: 'personal', definitionId: 'original' },
            },
          },
        },
      },
    })
  })

  it('rejects branched personal definition lineage', async () => {
    const archive = nativeFixture({
      mutateLocalData: (localData) => {
        const definition = (id: string, name: string, previousRevision?: string) => ({
          id,
          revision: previousRevision ? 1 : 0,
          ...(previousRevision ? {
            baseRef: { kind: 'personal', definitionId: 'original' },
            previousRevision: { kind: 'personal', definitionId: previousRevision },
          } : {}),
          kind: 'item',
          name,
          aliases: [],
          fields: {},
          sources: [],
          createdAt: '2026-01-02T03:04:05.000Z',
          updatedAt: '2026-01-02T03:04:05.000Z',
        })
        localData.personalDefinitions = {
          original: definition('original', 'Original'),
          first: definition('first', 'First', 'original'),
          second: definition('second', 'Second', 'original'),
        }
      },
    })

    await expect(previewNativeBackup(archive, 'branched-lineage.zip')).rejects.toMatchObject({ code: 'schema-mismatch' })
  })

  it.each([
    ['a personal base without a predecessor', (definitions: Record<string, Record<string, unknown>>) => {
      definitions.revised = {
        ...definitions.revised,
        previousRevision: undefined,
      }
    }],
    ['a changed predecessor kind', (definitions: Record<string, Record<string, unknown>>) => {
      definitions.revised = {
        ...definitions.revised,
        kind: 'class',
      }
    }],
  ])('rejects %s in personal definition lineage', async (_label, mutate) => {
    const archive = nativeFixture({
      mutateLocalData: (localData) => {
        const definitions = {
          original: {
            id: 'original',
            revision: 0,
            kind: 'item',
            name: 'Original',
            aliases: [],
            fields: {},
            sources: [],
            createdAt: '2026-01-02T03:04:05.000Z',
            updatedAt: '2026-01-02T03:04:05.000Z',
          },
          revised: {
            id: 'revised',
            revision: 1,
            baseRef: { kind: 'personal', definitionId: 'original' },
            previousRevision: { kind: 'personal', definitionId: 'original' },
            kind: 'item',
            name: 'Revised',
            aliases: [],
            fields: {},
            sources: [],
            createdAt: '2026-01-03T03:04:05.000Z',
            updatedAt: '2026-01-03T03:04:05.000Z',
          },
        }
        mutate(definitions)
        localData.personalDefinitions = definitions
      },
    })

    await expect(previewNativeBackup(archive, 'invalid-lineage.zip')).rejects.toMatchObject({ code: 'schema-mismatch' })
  })

  it('rejects an override whose kind differs from its exact catalog base', async () => {
    const archive = nativeFixture({
      mutateLocalData: (localData) => {
        localData.personalDefinitions = {
          override: {
            id: 'override',
            revision: 1,
            baseRef: {
              kind: 'catalog',
              catalogId: 'built-in',
              catalogRevisionId: 'revision-1',
              entityId: 'sword',
            },
            kind: 'class',
            name: 'Invalid class override',
            aliases: [],
            fields: {},
            sources: [],
            createdAt: '2026-01-02T03:04:05.000Z',
            updatedAt: '2026-01-02T03:04:05.000Z',
          },
        }
      },
      mutatePayload: (payload) => {
        payload.catalogs = [{
          id: 'built-in',
          revisionId: 'revision-1',
          schemaVersion: 'test',
          checksum: 'synthetic',
          importedAt: '2026-01-02T03:04:05.000Z',
          applicability: { state: 'known', value: 'synthetic' },
          rights: { state: 'known', value: 'synthetic fixture' },
          entities: {
            sword: {
              id: 'sword',
              kind: 'item',
              name: 'Sword',
              aliases: [],
              fields: {},
              sources: [],
            },
          },
          claims: [],
        }]
      },
    })

    await expect(previewNativeBackup(archive, 'catalog-kind-mismatch.zip')).rejects.toMatchObject({ code: 'schema-mismatch' })
  })

  it.each([
    ['an impossible calendar timestamp', (localData: Record<string, unknown>) => {
      localData.createdAt = '2025-02-30T00:00:00.000Z'
    }],
    ['a control character in an ID', (localData: Record<string, unknown>) => {
      localData.personalDefinitions = {
        'bad\u0000id': {
          id: 'bad\u0000id',
          revision: 0,
          kind: 'item',
          name: 'Fixture',
          aliases: [],
          fields: {},
          sources: [],
          createdAt: '2026-01-02T03:04:05.000Z',
          updatedAt: '2026-01-02T03:04:05.000Z',
        },
      }
    }],
    ['an invalid inventory quantity', (localData: Record<string, unknown>) => {
      selectedPlaythroughRecord(localData).inventory = {
        bad: {
          id: 'bad',
          revision: 0,
          ref: { kind: 'personal', definitionId: 'missing' },
          possession: 'owned',
          quantity: { kind: 'exact', value: -1 },
          favorite: false,
          protectedQuantity: 0,
          wishlist: false,
          sources: [],
          updatedAt: '2026-01-02T03:04:05.000Z',
        },
      }
    }],
    ['a nonstring personal definition name', (localData: Record<string, unknown>) => {
      localData.personalDefinitions = {
        bad: {
          id: 'bad',
          revision: 0,
          kind: 'item',
          name: 42,
          aliases: [],
          fields: {},
          sources: [],
          createdAt: '2026-01-02T03:04:05.000Z',
          updatedAt: '2026-01-02T03:04:05.000Z',
        },
      }
    }],
    ['a character missing its class progress map', (localData: Record<string, unknown>) => {
      selectedPlaythroughRecord(localData).characters = {
        bad: {
          id: 'bad',
          revision: 0,
          name: 'Fixture',
          snapshots: {},
          learnedNodes: {},
          createdAt: '2026-01-02T03:04:05.000Z',
          updatedAt: '2026-01-02T03:04:05.000Z',
        },
      }
    }],
    ['a gameSetup with nonarray slots', (localData: Record<string, unknown>) => {
      localData.gameSetups = {
        bad: {
          id: 'bad',
          gameSetupId: 'gameSetup',
          revision: 1,
          label: 'Fixture',
          platform: { state: 'unknown' },
          gameVersion: { state: 'unknown' },
          mode: { state: 'unknown' },
          mods: { state: 'unknown' },
          ppCostsNonNegative: { state: 'unknown' },
          slots: {},
          catalogLock: {},
          createdAt: '2026-01-02T03:04:05.000Z',
        },
      }
    }],
  ])('rejects %s anywhere in a native localData', async (_label, mutateLocalData) => {
    await expect(previewNativeBackup(nativeFixture({ mutateLocalData }), 'malformed.zip')).rejects.toMatchObject({
      code: 'schema-mismatch',
    })
  })
})
