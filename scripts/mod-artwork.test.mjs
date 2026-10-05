import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { hash } from './game-assets.mjs'
import { packArtwork, projectArtwork, runtimeManifest, safeTexturePath, main } from './update-mod-artwork.mjs'

const metadata = { projectId: 'synthetic-artwork', title: 'Synthetic artwork', version: '1' }
async function texture(color, width = 238, height = 68) {
  const bytes = await sharp({ create: { width, height, channels: 4, background: color } }).png().toBuffer()
  return { bytes, sha256: hash(bytes), width, height, origin: 'mod-export' }
}

describe('mod artwork extraction', () => {
  it('extracts exact cells and paired class portraits without mixing model families', async () => {
    const red = await texture('red')
    const blue = await texture('blue', 75, 144)
    const assets = {}
    const files = new Map()
    const root = { Equipment: [{ ID: 24, Name: 'Synthetic item', TexturePath: 'Equipment/Test', TextureIndex: 8 }], Jobs: [{ ID: 24, Name: 'Synthetic class', ActorTexturePathM: 'Actor/Test', ActorTexturePathF: 'Actor/Test' }] }
    const project = await projectArtwork(metadata, root, async path => path === 'Equipment/Test' ? red : blue, sharp, assets, files)
    assert.deepEqual(project.gaps, {})
    assert.notEqual(project.entities['Equipment:24'].asset, project.entities['Jobs:24'].asset)
    const item = assets[project.entities['Equipment:24'].asset]
    assert.equal(item.width, 32)
    assert.deepEqual(project.entities['Equipment:24'].rendering.sourceTextures[0].region, { x: 36, y: 36, width: 32, height: 32 })
    const portrait = assets[project.entities['Jobs:24'].asset]
    assert.equal(portrait.width, 32)
    assert.equal(portrait.height, 15)
    assert.equal((await sharp(files.get(item.file)).raw().toBuffer())[0], 255)
    const runtime = runtimeManifest({ assets, projects: { digest: project } })
    assert.equal(runtime.projects.digest.entities['Jobs:24'].sourceTextures[0].origin, 'mod-export')
    assert.equal(JSON.stringify(runtime).includes('textureSha256'), false)
    const packed = await packArtwork(assets, files, sharp)
    for (const asset of Object.values(assets)) {
      const atlas = packed.atlases[asset.atlas]
      const cropped = await sharp(packed.files.get(atlas.file)).extract({ left: asset.region.x, top: asset.region.y, width: asset.width, height: asset.height }).ensureAlpha().raw().toBuffer()
      assert.equal(cropped.equals(await sharp(files.get(asset.file)).ensureAlpha().raw().toBuffer()), true, 'Atlas crop must preserve every original pixel')
    }
  })

  it('keeps missing textures, incomplete classes, invalid crops, and unreadable companions as explicit gaps', async () => {
    const image = await texture('red')
    const root = { Jobs: [{ ID: 0, Name: 'No actor', ActorTexturePathM: null, ActorTexturePathF: null }], Equipment: [{ ID: 0, Name: 'Missing', TexturePath: 'Equipment/Missing', TextureIndex: 0 }, { ID: 1, Name: 'Out of bounds', TexturePath: 'Equipment/Test', TextureIndex: 999 }, { ID: 2, Name: 'Unsafe', TexturePath: '../Test', TextureIndex: 0 }, { ID: 3, Name: 'Unreadable', TexturePath: 'Equipment/Unreadable', TextureIndex: 0 }] }
    const project = await projectArtwork(metadata, root, async path => { if (path.endsWith('Unreadable')) throw Object.assign(new Error('private source pathname'), { code: 'EACCES' }); return path.endsWith('Test') ? image : undefined }, sharp, {}, new Map())
    assert.deepEqual(project.entities, {})
    assert.equal(Object.keys(project.gaps).length, 5)
    assert.equal(project.gaps['Equipment:3'].reason, 'Companion texture cannot be read')
    assert.equal(JSON.stringify(project).includes('private source pathname'), false)
  })

  it('only accepts bounded relative texture keys', () => {
    assert.equal(safeTexturePath('Actor/Synthetic actor'), true)
    for (const path of ['/Actor/Test', 'Actor/../Test', 'Actor/..', 'Actor/Test\\file', 'Actor/C:Test', 'Actor/Test\0']) assert.equal(safeTexturePath(path), false)
  })

  it('rejects missing, unknown, mixed, and empty CLI options before touching files', async () => {
    for (const args of [[], ['--unknown'], ['--check', '--game-content', 'example'], ['--input-directory=', '--game-content', 'example'], ['-i', 'example']]) assert.equal(await main(args), 2)
  })
})
