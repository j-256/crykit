#!/usr/bin/env node
import { readFile, readdir, mkdir, writeFile, lstat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { parseArgs } from 'node:util'
import { MOD_ARTWORK_FAMILIES, modArtworkKind, modArtworkReference } from '../src/domain/mod-artwork.ts'
import { classCompositeDimensions, hash, parseTexturePack, pngInfo, validateRegion } from './game-assets.mjs'
import { nativeArtworkPlan } from './native-artwork.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = join(ROOT, 'src/catalog/mod-artwork.json')
const RUNTIME_MANIFEST = join(ROOT, 'src/catalog/mod-artwork-runtime.json')
const ASSET_DIRECTORY = join(ROOT, 'src/assets/mod-artwork')
const ATLAS_DIRECTORY = join(ROOT, 'src/assets/mod-artwork-atlases')
const ATLAS_SIZE = 1024
const ATLAS_PADDING = 2
const FAMILY_DATABASES = Object.freeze({ Jobs: 'job', Equipment: 'equipment', Items: 'item', Abilities: 'ability', Statuses: 'status', Monsters: 'monster' })
const RIGHTS = 'Copyrighted third-party mod and Crystal Project artwork; no separate license grant asserted'
const SCHEMA_VERSION = 1
const HELP = `Usage: node --experimental-strip-types scripts/update-mod-artwork.mjs -c
       node --experimental-strip-types scripts/update-mod-artwork.mjs -i DIR -g DIR

Bundle direct artwork for the exact Crystal Edit sources in the mod library.
Project companion PNGs take precedence over fingerprinted game textures.
Missing sources, textures, and unsupported crops remain explicit gaps.
No source files change and no network requests or environment variables are used.
Requires Node >=22.12; generation and checking require the pinned sharp package.
  -i, --input-directory DIR  Directory containing mod JSON and companion folders
  -g, --game-content DIR     Game Content directory matching the native snapshot
  -c, --check                Validate committed sources, bindings, and PNG bytes
  -h, --help                 Print help
Results use stdout; diagnostics use stderr. Exit: 0 success/help, 1 runtime
failure, 2 invalid options or source preconditions, 3 missing dependencies.
`

const assert = (value, message) => { if (!value) throw new Error(message) }
const serialize = value => `${JSON.stringify(value, null, 2)}\n`

export function runtimeManifest(manifest) {
  return { assets: manifest.assets, atlases: manifest.atlases, projects: Object.fromEntries(Object.entries(manifest.projects).map(([digest, project]) => [digest, { projectId: project.projectId, title: project.title, version: project.version, entities: Object.fromEntries(Object.entries(project.entities).map(([key, binding]) => [key, { kind: binding.kind, asset: binding.asset, reference: binding.reference, sourceTextures: binding.rendering.sourceTextures.map(({ texturePath, origin }) => ({ texturePath, origin })) }])) }])) }
}

export async function packArtwork(assets, files, sharp) {
  const groups = []
  let group = []
  let x = 0
  let y = 0
  let rowHeight = 0
  for (const [digest, asset] of Object.entries(assets).sort(([leftKey, left], [rightKey, right]) => right.height - left.height || leftKey.localeCompare(rightKey))) {
    assert(asset.width <= ATLAS_SIZE && asset.height <= ATLAS_SIZE, 'Artwork exceeds the bounded atlas size')
    if (x + asset.width > ATLAS_SIZE) { x = 0; y += rowHeight + ATLAS_PADDING; rowHeight = 0 }
    if (y + asset.height > ATLAS_SIZE) { groups.push(group); group = []; x = 0; y = 0; rowHeight = 0 }
    group.push({ digest, region: { x, y, width: asset.width, height: asset.height } })
    x += asset.width + ATLAS_PADDING
    rowHeight = Math.max(rowHeight, asset.height)
  }
  if (group.length) groups.push(group)
  const atlases = {}
  const atlasFiles = new Map()
  for (const entries of groups) {
    const width = Math.max(...entries.map(entry => entry.region.x + entry.region.width))
    const height = Math.max(...entries.map(entry => entry.region.y + entry.region.height))
    const channels = 4
    const pixels = Buffer.alloc(width * height * channels)
    for (const entry of entries) {
      const original = await sharp(files.get(assets[entry.digest].file)).ensureAlpha().raw().toBuffer()
      const rowBytes = entry.region.width * channels
      for (let row = 0; row < entry.region.height; row++) original.copy(pixels, ((entry.region.y + row) * width + entry.region.x) * channels, row * rowBytes, (row + 1) * rowBytes)
    }
    const bytes = await sharp(pixels, { raw: { width, height, channels } }).png({ compressionLevel: 9 }).toBuffer()
    const digest = hash(bytes)
    atlases[digest] = { file: `${digest}.png`, sha256: digest, width, height, license: RIGHTS }
    atlasFiles.set(`${digest}.png`, bytes)
    for (const entry of entries) assets[entry.digest] = { ...assets[entry.digest], atlas: digest, region: entry.region }
  }
  return { atlases, files: atlasFiles }
}

export function safeTexturePath(path) {
  return typeof path === 'string' && path.split('/').length === 2 && path.split('/').every(part => part && part !== '.' && part !== '..' && !/[\\\x00-\x1f:]/.test(part))
}

async function librarySources() {
  const library = JSON.parse(await readFile(join(ROOT, 'src/catalog/bundled-mod-sources.json'), 'utf8'))
  const result = []
  for (const metadata of library.mods) {
    const packed = JSON.parse(await readFile(join(ROOT, `src/assets/mod-sources/${metadata.sha256}.json`), 'utf8'))
    assert(packed.schemaVersion === 1 && packed.encoding === 'gzip-base64', 'Unsupported bundled source encoding')
    const bytes = gunzipSync(Buffer.from(packed.data, 'base64'))
    assert(hash(bytes) === metadata.sha256 && bytes.length === packed.sourceBytes, 'Bundled mod source digest differs')
    const root = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes).replace(/^\uFEFF/, ''))
    assert(root.ID === metadata.projectId, 'Bundled mod project identity differs')
    result.push({ metadata, root })
  }
  return result
}

function artworkRecords(root) {
  return MOD_ARTWORK_FAMILIES.flatMap(family => (root[family] ?? []).flatMap(record => {
    const reference = modArtworkReference(family, record)
    return reference ? [{ key: `${family}:${record.ID}`, family, record, reference, kind: modArtworkKind(family) }] : []
  }))
}

export async function renderModArtwork(entry, textures, sharp) {
  const plan = nativeArtworkPlan({ id: entry.key, record: entry.record, nativeRecord: { database: FAMILY_DATABASES[entry.family] } }, textures)
  if (!plan) throw new Error('Record has no complete direct artwork reference')
  const crops = await Promise.all(plan.sourceTextures.map(source => {
    const region = source.region
    return sharp(textures.get(source.texturePath).bytes).extract({ left: region.x, top: region.y, width: region.width, height: region.height }).png({ compressionLevel: 9 }).toBuffer()
  }))
  let bytes = crops[0]
  if (plan.type === 'class') {
    const dimensions = classCompositeDimensions(plan.sourceTextures.map(source => source.region))
    let left = 0
    const layers = crops.map((input, index) => {
      const layer = { input, left, top: 0 }
      left += plan.sourceTextures[index].region.width + dimensions.gap
      return layer
    })
    bytes = await sharp({ create: { width: dimensions.width, height: dimensions.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(layers).png({ compressionLevel: 9 }).toBuffer()
  }
  return { bytes, extraction: plan.extraction, sourceTextures: plan.sourceTextures.map(source => ({ ...source, origin: textures.get(source.texturePath).origin, width: textures.get(source.texturePath).width, height: textures.get(source.texturePath).height })) }
}

export async function projectArtwork(metadata, root, loadTexture, sharp, assets, files) {
  const { visibleContentBounds } = await import('./sprite-content-bounds.mjs')
  const entities = {}
  const gaps = {}
  const cache = new Map()
  for (const entry of artworkRecords(root)) {
    const identity = { kind: entry.kind, name: entry.record.Name, reference: entry.reference }
    const textures = new Map()
    try {
      for (const path of entry.reference.filter(value => typeof value === 'string' && value)) {
        if (!safeTexturePath(path)) throw new Error('Texture reference is not a bounded relative texture path')
        if (!cache.has(path)) cache.set(path, await loadTexture(path))
        const texture = cache.get(path)
        if (texture) textures.set(path, texture)
      }
      const rendered = await renderModArtwork(entry, textures, sharp)
      const digest = hash(rendered.bytes)
      const dimensions = pngInfo(rendered.bytes, 'Mod artwork')
      if (!assets[digest]) assets[digest] = { file: `${digest}.png`, sha256: digest, ...dimensions, contentBounds: await visibleContentBounds(rendered.bytes), license: RIGHTS }
      files.set(`${digest}.png`, rendered.bytes)
      entities[entry.key] = { ...identity, asset: digest, rendering: { extraction: rendered.extraction, sourceTextures: rendered.sourceTextures } }
    } catch (error) {
      // Only bounded reasons are retained; filesystem errors can contain private paths
      gaps[entry.key] = { ...identity, reason: error.code ? 'Companion texture cannot be read' : error.message.startsWith('Native artwork texture is absent:') ? 'Declared texture is unavailable in this source snapshot' : ['Record has no complete direct artwork reference', 'Texture reference is not a bounded relative texture path'].includes(error.message) ? error.message : 'Declared texture is invalid or its crop is outside the source image' }
    }
  }
  return { projectId: metadata.projectId, title: metadata.title, version: metadata.version, entities, gaps }
}

async function diskSources(directory) {
  const sources = new Map()
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const path = join(directory, entry.name)
    const bytes = await readFile(path)
    sources.set(hash(bytes), path.slice(0, -'.json'.length))
  }
  return sources
}

async function gameTextures(directory) {
  const native = JSON.parse(await readFile(join(ROOT, 'src/catalog/game-assets.json'), 'utf8'))
  const textures = new Map()
  const packs = {}
  for (const name of ['Actor', 'Equipment', 'Icon', 'Monster']) {
    const expected = native.sources.texturePacks[name]
    assert(expected, `Native texture pack is absent from the snapshot: ${name}`)
    const bytes = await readFile(join(directory, 'Textures', `${name}.dat`))
    assert(hash(bytes) === expected.file.sha256, `Game texture pack differs from the native snapshot: ${name}`)
    packs[name] = { sha256: expected.file.sha256 }
    for (const texture of parseTexturePack(bytes, name).textures) textures.set(texture.path, { ...texture, origin: 'base-game-archive' })
  }
  return { textures, packs }
}

async function update(directory, content, sharp) {
  const sources = await librarySources()
  const disk = await diskSources(directory)
  const game = await gameTextures(content)
  const manifest = { schemaVersion: SCHEMA_VERSION, baseTexturePacks: game.packs, assets: {}, projects: {} }
  const files = new Map()
  for (const { metadata, root } of sources) {
    const companion = disk.get(metadata.sha256)
    const project = await projectArtwork(metadata, root, async path => {
      if (!companion) return undefined
      if (root.HasCustomContent && !root.IsLocalization) {
        const customPath = join(companion, `${path}.png`)
        try {
          for (const directory of [companion, join(companion, path.split('/')[0])]) assert((await lstat(directory)).isDirectory(), 'Companion directory is not a regular directory')
          const info = await lstat(customPath)
          if (!info.isFile()) throw new Error('Companion texture is not a regular file')
          const bytes = await readFile(customPath)
          return { bytes, sha256: hash(bytes), ...pngInfo(bytes, 'Companion texture'), origin: 'mod-export' }
        } catch (error) { if (error.code !== 'ENOENT') throw error }
      }
      return game.textures.get(path)
    }, sharp, manifest.assets, files)
    manifest.projects[metadata.sha256] = project
  }
  const packed = await packArtwork(manifest.assets, files, sharp)
  manifest.atlases = packed.atlases
  await mkdir(ATLAS_DIRECTORY, { recursive: true })
  for (const [name, bytes] of packed.files) await writeFile(join(ATLAS_DIRECTORY, name), bytes)
  await mkdir(ASSET_DIRECTORY, { recursive: true })
  for (const [name, bytes] of files) await writeFile(join(ASSET_DIRECTORY, name), bytes)
  await writeFile(MANIFEST, serialize(manifest))
  await writeFile(RUNTIME_MANIFEST, serialize(runtimeManifest(manifest)))
  return validate(sharp)
}

export async function validate(sharp) {
  const { validateContentBounds, visibleContentBounds } = await import('./sprite-content-bounds.mjs')
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'))
  assert(manifest.schemaVersion === SCHEMA_VERSION, 'Unsupported mod artwork schema')
  assert(await readFile(RUNTIME_MANIFEST, 'utf8') === serialize(runtimeManifest(manifest)), 'Mod artwork runtime projection differs')
  const native = JSON.parse(await readFile(join(ROOT, 'src/catalog/game-assets.json'), 'utf8'))
  for (const [pack, value] of Object.entries(manifest.baseTexturePacks)) assert(native.sources.texturePacks[pack]?.file.sha256 === value.sha256, 'Mod artwork native texture fingerprint differs')
  const sources = await librarySources()
  assert(Object.keys(manifest.projects).length === sources.length, 'Mod artwork project coverage differs')
  const expectedFiles = new Set()
  let bindings = 0
  let gaps = 0
  for (const { metadata, root } of sources) {
    const project = manifest.projects[metadata.sha256]
    assert(project?.projectId === metadata.projectId && project.title === metadata.title && project.version === metadata.version, 'Mod artwork project revision differs')
    const records = artworkRecords(root)
    assert(Object.keys(project.entities).length + Object.keys(project.gaps).length === records.length, 'Mod artwork record coverage differs')
    for (const entry of records) {
      const binding = project.entities[entry.key]
      const gap = project.gaps[entry.key]
      assert(Boolean(binding) !== Boolean(gap), 'Mod artwork must have exactly one binding or gap')
      const identity = binding ?? gap
      assert(identity.kind === entry.kind && identity.name === entry.record.Name && JSON.stringify(identity.reference) === JSON.stringify(entry.reference), 'Mod artwork record or texture identity differs')
      if (!binding) { assert(typeof gap.reason === 'string' && gap.reason.length > 0, 'Mod artwork gap needs a reason'); gaps++; continue }
      const textures = new Map(binding.rendering.sourceTextures.map(source => [source.texturePath, { ...source, sha256: source.textureSha256 }]))
      const plan = nativeArtworkPlan({ id: entry.key, record: entry.record, nativeRecord: { database: FAMILY_DATABASES[entry.family] } }, textures)
      assert(plan && plan.extraction === binding.rendering.extraction, 'Mod artwork extraction differs')
      assert(JSON.stringify(plan.sourceTextures) === JSON.stringify(binding.rendering.sourceTextures.map(({ field, texturePath, textureSha256, region }) => ({ ...(field ? { field } : {}), texturePath, textureSha256, region }))), 'Mod artwork crop differs')
      for (const source of binding.rendering.sourceTextures) {
        assert(safeTexturePath(source.texturePath) && /^[a-f0-9]{64}$/.test(source.textureSha256), 'Invalid mod texture provenance')
        assert(['mod-export', 'base-game-archive'].includes(source.origin), 'Invalid mod texture origin')
        validateRegion(source.region, source)
        if (source.origin === 'base-game-archive') assert(native.sources.texturePacks[source.texturePath.split('/')[0]]?.textures.some(texture => texture.path === source.texturePath && texture.sha256 === source.textureSha256 && texture.width === source.width && texture.height === source.height), 'Mod artwork base texture differs')
      }
      const asset = manifest.assets[binding.asset]
      assert(asset?.file === `${binding.asset}.png` && asset.sha256 === binding.asset, 'Mod artwork binding asset is invalid')
      expectedFiles.add(asset.file)
      bindings++
    }
  }
  assert(Object.keys(manifest.assets).length === expectedFiles.size, 'Unreferenced mod artwork assets')
  const atlasPixels = new Map()
  for (const [digest, atlas] of Object.entries(manifest.atlases)) {
    const bytes = await readFile(join(ATLAS_DIRECTORY, atlas.file))
    assert(atlas.file === `${digest}.png` && hash(bytes) === digest, 'Mod atlas bytes differ')
    const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    assert(info.width === atlas.width && info.height === atlas.height, 'Mod atlas dimensions differ')
    atlasPixels.set(digest, { data, info })
  }
  const usedAtlases = new Set()
  for (const asset of Object.values(manifest.assets)) {
    const bytes = await readFile(join(ASSET_DIRECTORY, asset.file))
    assert(hash(bytes) === asset.sha256, 'Mod artwork bytes differ')
    const dimensions = await sharp(bytes).metadata()
    assert(dimensions.width === asset.width && dimensions.height === asset.height, 'Mod artwork dimensions differ')
    validateContentBounds(asset.contentBounds, asset)
    assert(JSON.stringify(asset.contentBounds) === JSON.stringify(await visibleContentBounds(bytes)), 'Mod artwork visible bounds differ')
    const atlas = atlasPixels.get(asset.atlas)
    assert(atlas, 'Mod artwork atlas is absent')
    validateRegion(asset.region, atlas.info)
    assert(asset.region.width === asset.width && asset.region.height === asset.height, 'Mod artwork atlas crop dimensions differ')
    const original = await sharp(bytes).ensureAlpha().raw().toBuffer()
    for (let row = 0; row < asset.height; row++) {
      const offset = ((asset.region.y + row) * atlas.info.width + asset.region.x) * atlas.info.channels
      assert(original.subarray(row * asset.width * atlas.info.channels, (row + 1) * asset.width * atlas.info.channels).equals(atlas.data.subarray(offset, offset + asset.width * atlas.info.channels)), 'Mod atlas crop pixels differ from the original artwork')
    }
    usedAtlases.add(asset.atlas)
  }
  const actual = await readdir(ASSET_DIRECTORY)
  assert(actual.length === expectedFiles.size && actual.every(name => expectedFiles.has(name)), 'Mod artwork directory contains missing or unexpected assets')
  const atlasNames = await readdir(ATLAS_DIRECTORY)
  assert(usedAtlases.size === atlasPixels.size && atlasNames.length === atlasPixels.size && atlasNames.every(name => manifest.atlases[name.replace(/\.png$/, '')]?.file === name), 'Mod atlas directory contains missing or unexpected assets')
  return { bindings, gaps, assets: expectedFiles.size }
}

export async function main(argv = process.argv.slice(2)) {
  let values
  try {
    ;({ values } = parseArgs({ args: argv, allowPositionals: false, options: { check: { type: 'boolean', short: 'c' }, 'input-directory': { type: 'string', short: 'i' }, 'game-content': { type: 'string', short: 'g' }, help: { type: 'boolean', short: 'h' } } }))
    if (values.help) { process.stdout.write(HELP); return 0 }
    assert(values.check ? !values['input-directory'] && !values['game-content'] : values['input-directory']?.trim() && values['game-content']?.trim(), 'Choose --check or provide --input-directory and --game-content')
  } catch (error) { console.error(error.message); return 2 }
  let sharp
  try { sharp = (await import('sharp')).default } catch { console.error('The pinned sharp package is required; run npm ci'); return 3 }
  try {
    const result = values.check ? await validate(sharp) : await update(resolve(values['input-directory']), resolve(values['game-content']), sharp)
    process.stdout.write(`${values.check ? 'Validated' : 'Generated'} mod artwork: ${result.bindings} bindings, ${result.gaps} explicit gaps, ${result.assets} assets\n`)
    return 0
  } catch (error) { console.error(error.message); return 1 }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main()
