import { afterEach, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { normalizeProjectPath, previewModFolder } from './folder-import'

const project = (id: string, version = '1') => new File([JSON.stringify({ ID: id, Title: id, Version: version, EditorVersion: 34, Items: [{ ID: 1, Name: 'Synthetic item' }] })], `${id}.json`, { type: 'application/json' })
const png = new File([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137])], 'icon.png', { type: 'image/png' })
afterEach(() => { vi.unstubAllGlobals() })

it('previewsOnlyRecognizedProjectsAndSelectedAssets', async () => {
  const decode = vi.fn(async () => ({ width: 1, height: 1, close: () => {} }))
  vi.stubGlobal('createImageBitmap', decode)
  const secretFile = { relativePath: 'private/notes.txt', file: new File(['secret'], 'notes.txt') }
  const request = vi.spyOn(globalThis, 'fetch')
  const preview = await previewModFolder([
    { relativePath: 'mods/a.json', file: project('project-a') },
    { relativePath: 'mods/b.json', file: project('project-b') },
    { relativePath: 'mods/icon.png', file: png },
    { relativePath: 'mods/invalid.png', file: new File(['not an image'], 'invalid.png') },
    secretFile,
  ])
  expect(preview.selectedArtwork).toEqual([])
  expect(preview.projects.map(p => p.projectId)).toEqual(['project-a', 'project-b'])
  expect(preview.uploadCandidates).not.toContain(secretFile)
  expect(preview.uploadCandidates).toHaveLength(1)
  expect(preview.excludedFiles.map(file => file.relativePath)).toContain('private/notes.txt')
  expect(preview.excludedFiles.map(file => file.relativePath)).toContain('mods/invalid.png')
  expect(preview.unresolvedAssociations).toEqual(['mods/icon.png'])
  expect(preview.projects[0]?.originalRelativePath).toBe('mods/a.json')
  expect(request).not.toHaveBeenCalled()
  expect(decode).toHaveBeenCalledOnce()
})

it('rejectsTraversalAbsoluteUrlsAndCaseAmbiguity', async () => {
  for (const path of ['../private.json', '/root.json', 'C:\\game\\file.png', '\\\\server\\file.png', 'https://example.test/a.png', 'a/%2e%2e/b.png', 'a/%2f/b.png', 'a/\0b.png', 'a//b.png', 'a/./b.png']) expect(() => normalizeProjectPath(path)).toThrow()
  expect(normalizeProjectPath('mods\\art\\icon.png')).toBe('mods/art/icon.png')
  await expect(previewModFolder([{ relativePath: 'A.json', file: project('a') }, { relativePath: 'a.json', file: project('b') }])).rejects.toThrow(/ambiguous|collision|duplicate/i)
  await expect(previewModFolder([{ relativePath: 'same.json', file: project('a') }, { relativePath: 'same.json', file: project('b') }])).rejects.toThrow(/ambiguous|collision|duplicate/i)
  const revisions = await previewModFolder([{ relativePath: 'v1.json', file: project('a', '1') }, { relativePath: 'v2.json', file: project('a', '2') }])
  expect(revisions.projects).toHaveLength(2)
  expect(revisions.projects[0]?.sourceId).not.toBe(revisions.projects[1]?.sourceId)
  const separated = await previewModFolder([{ relativePath: 'mods\\a.json', file: project('a') }])
  expect(separated.projects[0]?.relativePath).toBe('mods/a.json')
  expect(separated.projects[0]?.importPreview.proposed.sources[0]?.filename).toBe('mods\\a.json')
})

it('rejects an oversized image header before decode while keeping valid JSON', async () => {
  const decode = vi.fn(async () => ({ width: 1, height: 1, close: () => {} }))
  vi.stubGlobal('createImageBitmap', decode)
  const bytes = new Uint8Array(await png.arrayBuffer())
  new DataView(bytes.buffer).setUint32(16, 9000)
  const preview = await previewModFolder([{ relativePath: 'project.json', file: project('bounded') }, { relativePath: 'huge.png', file: new File([bytes], 'huge.png') }])
  expect(preview.projects).toHaveLength(1)
  expect(preview.uploadCandidates).toEqual([])
  expect(preview.excludedFiles[0]?.reason).toMatch(/dimensions exceed/)
  expect(decode).not.toHaveBeenCalled()
})

it('recognizes decoded JPEG and WebP images by signature', async () => {
  vi.stubGlobal('createImageBitmap', async () => ({ width: 20, height: 16, close: () => {} }))
  const image = sharp({ create: { width: 20, height: 16, channels: 3, background: '#99ccff' } })
  const jpeg = new File([new Uint8Array(await image.jpeg().toBuffer())], 'preview.jpg')
  const webp = new File([new Uint8Array(await image.webp().toBuffer())], 'preview.webp')
  const preview = await previewModFolder([{ relativePath: 'preview.jpg', file: jpeg }, { relativePath: 'preview.webp', file: webp }])
  expect(preview.uploadCandidates.map(candidate => candidate.mediaType)).toEqual(['image/jpeg', 'image/webp'])
  expect(preview.excludedFiles).toEqual([])
})
