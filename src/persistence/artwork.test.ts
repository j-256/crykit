import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { installProfile, invalidateProfile } from '../account/profile'
import { AccountDatabase } from './account-database'
import { accountLocalId } from '../workspace/account-cache'
import { openAccountRepository } from '../workspace/account-repository'
import { attachArtworkFile, attachSourceArtwork, findArtworkBinding, findPrivateArtworkForEntity, openPrivateArtwork, privateArtworkRegion } from '../workspace/artwork-repository'
import { blobIdentity, readBlob } from '../workspace/blobs'
import { confirmModFolder, previewModFolder } from '../workspace/folder-import'

let database: AccountDatabase | undefined
afterEach(async () => { invalidateProfile(); vi.unstubAllGlobals(); await database?.delete(); database = undefined })

async function image(color: string) { return sharp({ create: { width: 240, height: 36, channels: 4, background: color } }).png().toBuffer() }
function source() { return new File([JSON.stringify({ ID: 'art-project', Title: 'Synthetic art project', EditorVersion: 34, Items: [{ ID: 7, Name: 'Synthetic item', TexturePath: 'icon', TextureIndex: 0 }] })], 'mod.json', { type: 'application/json' }) }

it('laterArtworkDoesNotCreateModRevision', async () => {
  vi.stubGlobal('createImageBitmap', async (file: File) => { const metadata = await sharp(Buffer.from(await file.arrayBuffer())).metadata(); return { width: metadata.width, height: metadata.height, close() {} } })
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const repository = await openAccountRepository(token)
  const original = await image('#3366cc')
  const preview = await previewModFolder([{ relativePath: 'mod.json', file: source() }, { relativePath: 'icon.png', file: new File([original], 'icon.png', { type: 'image/png' }) }])
  const chosen = preview.projects[0]!
  const receipt = (await confirmModFolder(repository, preview, { projects: [{ projectId: chosen.projectId, sourceId: chosen.sourceId, relativePath: chosen.relativePath, choices: { inReference: true, futureDefault: false } }], assets: [{ relativePath: 'icon.png', projectId: chosen.projectId, sourceId: chosen.sourceId, projectRelativePath: chosen.relativePath }] }))[0]!
  expect(receipt.savedArtworkCount).toBe(1)
  const first = await repository.readWorkspace()
  const revision = first.planner.catalogs.find(value => value.id === receipt.catalogId)!.revisionId
  const entity = Object.values(first.planner.catalogs.find(value => value.id === receipt.catalogId)!.entities)[0]!
  const found = findPrivateArtworkForEntity(first, receipt.catalogId, entity)
  expect(found).toBeDefined()
  expect(findPrivateArtworkForEntity(first, receipt.catalogId, entity, 'wrong')).toBeUndefined()
  expect(found!.sourceKey).toContain('"modelId":7')
  expect(findPrivateArtworkForEntity({ ...first, assets: [{ ...found!, sourceKey: 'synthetic' }] }, receipt.catalogId, entity)).toBeUndefined()
  const priorBindings = (JSON.parse(found!.sourceKey.slice('private-mod-artwork-v1:'.length)) as Record<string, unknown>[]).map(({ sourcePath: _sourcePath, ...binding }) => binding)
  expect(findPrivateArtworkForEntity({ ...first, assets: [{ ...found!, sourceKey: `private-mod-artwork-v1:${JSON.stringify(priorBindings)}` }] }, receipt.catalogId, entity)).toBeDefined()
  expect(() => findArtworkBinding(first, { catalogId: receipt.catalogId, catalogRevisionId: revision }, 'ICON.png')).toThrow('no exact model texture match')
  expect(() => findArtworkBinding(first, { catalogId: receipt.catalogId, catalogRevisionId: 'wrong' as typeof revision }, 'icon.png')).toThrow('exact mod revision')
  const wrongIndex = { ...entity, fields: { ...entity.fields, 'Crystal Edit source record': { state: 'known' as const, value: { ID: 7, TexturePath: 'icon', TextureIndex: 999 }, sources: [] } } }
  expect(privateArtworkRegion(wrongIndex, found!)).toBeUndefined()
  await expect(attachSourceArtwork(repository, { catalogId: receipt.catalogId, catalogRevisionId: revision }, [{ ...found!, thumbnail: { ...found!.original, documentId: 'asset:missing-thumbnail' } }])).rejects.toThrow('staged')
  const replacement = await image('#cc6633')
  await attachArtworkFile(repository, { catalogId: receipt.catalogId, catalogRevisionId: revision }, 'icon.png', new File([replacement], 'icon.png', { type: 'image/png' }))
  const reopened = await openAccountRepository(token)
  const second = await reopened.readWorkspace()
  expect(second.planner.catalogs.find(value => value.id === receipt.catalogId)!.revisionId).toBe(revision)
  expect(second.assets).toHaveLength(1)
  expect(second.assets[0]!.id).not.toBe(found!.id)
  const body = second.blobs.find(value => blobIdentity(value.ref) === blobIdentity(second.assets[0]!.original))!
  expect(await readBlob(body.content, replacement.length)).toEqual(new Uint8Array(replacement))
})

it('lockSwitchAndDecodeFailureRevokePrivateUrls', async () => {
  vi.stubGlobal('createImageBitmap', async (file: File) => { const metadata = await sharp(Buffer.from(await file.arrayBuffer())).metadata(); return { width: metadata.width, height: metadata.height, close() {} } })
  const revoked: string[] = []
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:private-test', revokeObjectURL: (url: string) => revoked.push(url) })
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const repository = await openAccountRepository(token)
  const original = await image('#66aacc')
  const preview = await previewModFolder([{ relativePath: 'mod.json', file: source() }, { relativePath: 'icon.png', file: new File([original], 'icon.png', { type: 'image/png' }) }])
  const chosen = preview.projects[0]!
  await confirmModFolder(repository, preview, { projects: [{ projectId: chosen.projectId, sourceId: chosen.sourceId, relativePath: chosen.relativePath, choices: { inReference: false, futureDefault: false } }], assets: [{ relativePath: 'icon.png', projectId: chosen.projectId, sourceId: chosen.sourceId, projectRelativePath: chosen.relativePath }] })
  const asset = (await repository.readWorkspace()).assets[0]!
  const opened = await openPrivateArtwork(token, asset.id)
  expect(opened.url).toBe('blob:private-test')
  vi.stubGlobal('createImageBitmap', async () => { throw new Error('synthetic decode failure') })
  await expect(openPrivateArtwork(token, asset.id)).rejects.toThrow('synthetic decode failure')
  invalidateProfile()
  expect(revoked).toContain('blob:private-test')
  await expect(openPrivateArtwork(token, asset.id)).rejects.toThrow()
})

it('failedSelectedArtworkKeepsJsonAvailableForReconfirmation', async () => {
  vi.stubGlobal('createImageBitmap', async (file: File) => { const metadata = await sharp(Buffer.from(await file.arrayBuffer())).metadata(); return { width: metadata.width, height: metadata.height, close() {} } })
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const repository = await openAccountRepository(token)
  const original = await image('#aa6633')
  const preview = await previewModFolder([{ relativePath: 'mod.json', file: source() }, { relativePath: 'icon.png', file: new File([original], 'icon.png', { type: 'image/png' }) }])
  const chosen = preview.projects[0]!
  const selectedProject = { projectId: chosen.projectId, sourceId: chosen.sourceId, relativePath: chosen.relativePath, choices: { inReference: false, futureDefault: false } }
  const tampered = { ...preview, uploadCandidates: [{ ...preview.uploadCandidates[0]!, file: new File(['<svg/>'], 'icon.png', { type: 'image/png' }) }] }
  await expect(confirmModFolder(repository, tampered, { projects: [selectedProject], assets: [{ relativePath: 'icon.png', projectId: chosen.projectId, sourceId: chosen.sourceId, projectRelativePath: chosen.relativePath }] })).rejects.toThrow('Selected artwork could not be saved')
  expect((await repository.readWorkspace()).planner.sources).toHaveLength(0)
  expect((await repository.readWorkspace()).assets).toHaveLength(0)
  await confirmModFolder(repository, tampered, { projects: [selectedProject], assets: [] })
  expect((await repository.readWorkspace()).planner.sources).toHaveLength(1)
})

it('companionArtworkBindsOnlyToTheSelectedSourceDirectory', async () => {
  vi.stubGlobal('createImageBitmap', async (file: File) => { const metadata = await sharp(Buffer.from(await file.arrayBuffer())).metadata(); return { width: metadata.width, height: metadata.height, close() {} } })
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const repository = await openAccountRepository(token)
  const original = await image('#4477aa')
  const project = (id: string) => new File([JSON.stringify({ ID: id, Title: id, EditorVersion: 34, Equipment: [{ ID: 7, Name: 'Synthetic equipment', TexturePath: 'Equipment/Test', TextureIndex: 0 }] })], `${id}.json`, { type: 'application/json' })
  const preview = await previewModFolder([
    { relativePath: 'mod.json', file: project('mod') },
    { relativePath: 'mod\\Equipment\\Test.png', file: new File([original], 'Test.png', { type: 'image/png' }) },
    { relativePath: 'other.json', file: project('other') },
    { relativePath: 'other/Equipment/Test.png', file: new File([original], 'Test.png', { type: 'image/png' }) },
  ])
  const chosen = preview.projects.find(value => value.relativePath === 'mod.json')!
  const selectedProject = { projectId: chosen.projectId, sourceId: chosen.sourceId, relativePath: chosen.relativePath, choices: { inReference: true, futureDefault: false } }
  await expect(confirmModFolder(repository, preview, { projects: [selectedProject], assets: [{ relativePath: 'other/Equipment/Test.png', projectId: chosen.projectId, sourceId: chosen.sourceId, projectRelativePath: chosen.relativePath }] })).rejects.toThrow('Selected artwork could not be saved')
  expect((await repository.readWorkspace()).planner.sources).toHaveLength(0)
  const receipt = (await confirmModFolder(repository, preview, { projects: [selectedProject], assets: [{ relativePath: 'mod/Equipment/Test.png', projectId: chosen.projectId, sourceId: chosen.sourceId, projectRelativePath: chosen.relativePath }] }))[0]!
  expect(receipt.savedArtworkCount).toBe(1)
  const state = await repository.readWorkspace()
  const pin = { catalogId: receipt.catalogId, catalogRevisionId: receipt.catalogRevisionId }
  expect(() => findArtworkBinding(state, pin, 'other/Equipment/Test.png')).toThrow('no exact model texture match')
  expect(() => findArtworkBinding(state, pin, 'mod/equipment/Test.png')).toThrow('no exact model texture match')
  expect(() => findArtworkBinding(state, pin, 'mod/../other/Equipment/Test.png')).toThrow('Unsafe or ambiguous')
  const entity = Object.values(state.planner.catalogs.find(value => value.id === receipt.catalogId)!.entities)[0]!
  const found = findPrivateArtworkForEntity(state, receipt.catalogId, entity)
  expect(found?.relativePath).toBe('mod\\Equipment\\Test.png')
  await attachSourceArtwork(repository, pin, [found!])
})

it('exactByteReimportKeepsTheChosenCompanionPath', async () => {
  vi.stubGlobal('createImageBitmap', async (file: File) => { const metadata = await sharp(Buffer.from(await file.arrayBuffer())).metadata(); return { width: metadata.width, height: metadata.height, close() {} } })
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const repository = await openAccountRepository(token)
  const json = JSON.stringify({ ID: 'reimport-project', Title: 'Reimported project', EditorVersion: 34, Equipment: [{ ID: 7, Name: 'Reimported equipment', TexturePath: 'Equipment/T\u00e9st', TextureIndex: 0 }] })
  const first = await previewModFolder([
    { relativePath: 'first/mod.json', file: new File([json], 'mod.json', { type: 'application/json' }) },
    { relativePath: 'first/mod/Equipment/T\u00e9st.png', file: new File([await image('#225588')], 'T\u00e9st.png', { type: 'image/png' }) },
  ])
  const firstCandidate = first.projects[0]!
  await confirmModFolder(repository, first, { projects: [{ projectId: firstCandidate.projectId, sourceId: firstCandidate.sourceId, relativePath: firstCandidate.relativePath, choices: { inReference: true, futureDefault: false } }], assets: [{ relativePath: 'first/mod/Equipment/T\u00e9st.png', projectId: firstCandidate.projectId, sourceId: firstCandidate.sourceId, projectRelativePath: firstCandidate.relativePath }] })
  expect((await repository.readWorkspace()).planner.sources[0]?.filename).toBe('first/mod.json')
  const oldOriginal = (await repository.readWorkspace()).assets[0]!.original
  const original = await image('#8844cc')
  const second = await previewModFolder([
    { relativePath: 'second/mod.json', file: new File([json], 'mod.json', { type: 'application/json' }) },
    { relativePath: 'second/mod/Equipment/Te\u0301st.png', file: new File([original], 'Te\u0301st.png', { type: 'image/png' }) },
  ])
  const chosen = second.projects[0]!
  const receipt = (await confirmModFolder(repository, second, { projects: [{ projectId: chosen.projectId, sourceId: chosen.sourceId, relativePath: chosen.relativePath, choices: { inReference: true, futureDefault: false } }], assets: [{ relativePath: 'second/mod/Equipment/T\u00e9st.png', projectId: chosen.projectId, sourceId: chosen.sourceId, projectRelativePath: chosen.relativePath }] }))[0]!
  const state = await repository.readWorkspace()
  const entity = Object.values(state.planner.catalogs.find(value => value.id === receipt.catalogId)!.entities)[0]!
  expect(state.planner.sources[0]?.filename).toBe('first/mod.json')
  expect(state.assets).toHaveLength(1)
  expect(state.blobs.some(value => blobIdentity(value.ref) === blobIdentity(oldOriginal))).toBe(true)
  expect(findPrivateArtworkForEntity(state, receipt.catalogId, entity)?.relativePath).toBe('second/mod/Equipment/Te\u0301st.png')
})
