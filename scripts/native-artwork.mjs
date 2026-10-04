import { buildNativeCatalog, nativeIdentity, nativeSourceRecord } from '../src/domain/native-game.ts'
import { actorIconRegion, gameIconRegion, validateRegion } from './game-assets.mjs'

export const NO_NATIVE_ARTWORK = 'Native record has no supported direct artwork reference'
const INDEXED_FAMILIES = new Set(['item', 'equipment', 'ability', 'status'])
export const NATIVE_UI_ARTWORK = Object.freeze({
  classSeal: { label: 'Class mastery seal', entityId: 'base:item:warrior-seal' },
  // WindowHelper.DrawCurrency uses these exact GUI/Currency rectangles
  goldCoin: { label: 'Gold coin', texturePath: 'GUI/Currency', region: { x: 1, y: 0, width: 16, height: 18 } },
  silverCoin: { label: 'Silver coin', texturePath: 'GUI/Currency', region: { x: 19, y: 0, width: 16, height: 18 } },
  copperCoin: { label: 'Copper coin', texturePath: 'GUI/Currency', region: { x: 37, y: 0, width: 16, height: 18 } },
})
export const CURRENCY_ARTWORK_EXTRACTION = 'WindowHelper.DrawCurrency source rectangle'
export const CLASS_WORLD_EXTRACTION = 'paired actor-sheet standing frames'
export const MENU_ICON_EXTRACTION = 'native menu icon cell at half size with nearest-neighbor sampling'
export const MENU_ICON_SIZE = 16
const ACTOR_COLUMNS = 3
const ACTOR_ROWS = 4
const ACTOR_STANDING_COLUMN = 1
const ACTOR_TEXTURE_FIELDS = ['ActorTexturePathM', 'ActorTexturePathF']
const SCROLL_ITEM_ID = 263
const MENU_COMMAND_JOB_IDS = new Set([1, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23])
// Reviewed CWindow menu tables and WindowHelper consumers in the pinned executable
const MENU_CELL_SOURCES = Object.freeze([
  ['equipment:katanas', 'Icon/SystemB', 32, 'CWindow.EQUIP_TYPE_ICON_INDEX[EquipmentType.Katana]'],
  ['skill:ability', 'Icon/SystemA', 3, 'CWindow.ABILITY_ICON_INDEX[SangAbilityCategory.Skill]'],
  ['skill:black magic', 'Icon/SystemA', 7, 'CWindow.ABILITY_ICON_INDEX[SangAbilityCategory.BlackMagic]'],
  ['skill:green magic', 'Icon/SystemA', 9, 'CWindow.ABILITY_ICON_INDEX[SangAbilityCategory.GrayMagic]'],
  ['skill:monster magic', 'Icon/SystemA', 10, 'CWindow.ABILITY_ICON_INDEX[SangAbilityCategory.MonsterMagic]'],
  ['skill:white magic', 'Icon/SystemA', 8, 'CWindow.ABILITY_ICON_INDEX[SangAbilityCategory.WhiteMagic]'],
  ['skill:axe/dagger skill', 'Icon/SystemA', 28, 'CWindow.ABILITY_ICON_INDEX[SangAbilityCategory.AxeDaggerSkill]'],
  ['skill:dagger/axe skill', 'Icon/SystemA', 28, 'CWindow.ABILITY_ICON_INDEX[SangAbilityCategory.AxeDaggerSkill]'],
  ['skill:axe/unarmed skill', 'Icon/SystemA', 6, 'CWindow.ABILITY_ICON_INDEX[SangAbilityCategory.AxeUnarmedSkill]'],
  ['skill:bow skill', 'Icon/SystemA', 21, 'CWindow.ABILITY_ICON_INDEX[SangAbilityCategory.BowSkill]'],
  ['skill:dagger skill', 'Icon/SystemA', 16, 'CWindow.ABILITY_ICON_INDEX[SangAbilityCategory.DaggerSkill]'],
  ['skill:dagger/rapier skill', 'Icon/SystemA', 25, 'CWindow.ABILITY_ICON_INDEX[SangAbilityCategory.DaggerRapierSkill]'],
  ['skill:katana skill', 'Icon/SystemA', 18, 'CWindow.ABILITY_ICON_INDEX[SangAbilityCategory.KatanaSkill]'],
  ['skill:rapier/sword skill', 'Icon/SystemA', 13, 'CWindow.ABILITY_ICON_INDEX[SangAbilityCategory.SwordRapierSkill]'],
  ['skill:scythe skill', 'Icon/SystemA', 20, 'CWindow.ABILITY_ICON_INDEX[SangAbilityCategory.ScytheSkill]'],
  ['skill:spear/sword skill', 'Icon/SystemA', 29, 'CWindow.ABILITY_ICON_INDEX[SangAbilityCategory.SwordSpearSkill]'],
  ['skill:staff/spear skill', 'Icon/SystemA', 27, 'CWindow.ABILITY_ICON_INDEX[SangAbilityCategory.SpearStaffSkill]'],
  ['skill:unarmed/staff skill', 'Icon/SystemA', 12, 'CWindow.ABILITY_ICON_INDEX[SangAbilityCategory.StaffUnarmedSkill]'],
  ['skill:weapon skill', 'Icon/SystemA', 1, 'CWindow.ABILITY_ICON_INDEX[SangAbilityCategory.WeaponSkill]'],
  ['skill:magic stance', 'Icon/SystemA', 30, 'CWindow.ABILITY_ICON_INDEX[SangAbilityCategory.StanceMagic]'],
  ['skill:stance', 'Icon/SystemA', 4, 'CWindow.ABILITY_ICON_INDEX[SangAbilityCategory.Stance]'],
  ['skill:passive', 'Icon/SystemB', 1, 'WindowHelper.DrawLabeledPassive; CWindow.PASSIVE_ON_ICON_INDEX'],
  ['element:earth', 'Icon/SystemB', 8, 'CWindow.ELEMENT_TYPE_ICON_INDEX[ElementType.Earth]'],
  ['element:fire', 'Icon/SystemB', 12, 'CWindow.ELEMENT_TYPE_ICON_INDEX[ElementType.Fire]'],
  ['element:ice', 'Icon/SystemB', 11, 'CWindow.ELEMENT_TYPE_ICON_INDEX[ElementType.Ice]'],
  ['element:thunder', 'Icon/SystemB', 10, 'CWindow.ELEMENT_TYPE_ICON_INDEX[ElementType.Thunder]'],
  ['element:water', 'Icon/SystemB', 7, 'CWindow.ELEMENT_TYPE_ICON_INDEX[ElementType.Water]'],
  ['element:wind', 'Icon/SystemB', 9, 'CWindow.ELEMENT_TYPE_ICON_INDEX[ElementType.Wind]'],
])

function textureSource(textures, texturePath, region, field) {
  const texture = textures.get(texturePath)
  if (!texture) throw new Error(`Native reference artwork texture is absent: ${texturePath}`)
  validateRegion(region, texture, `Native reference artwork ${texturePath}`)
  return { ...(field ? { field } : {}), texturePath, textureSha256: texture.sha256, region }
}

export function nativeReferenceArtworkPlans(snapshot, textures) {
  const classWorld = {}
  for (const entry of nativeArtworkEntries(snapshot).filter(entry => entry.nativeRecord.database === 'job' && entry.nativeRecord.mode === 'base')) {
    const sources = ACTOR_TEXTURE_FIELDS.map(field => {
      const texture = textures.get(entry.record[field])
      if (!texture || texture.width % ACTOR_COLUMNS || texture.height % ACTOR_ROWS) throw new Error(`Native class standing-frame dimensions are invalid: ${entry.id}`)
      return textureSource(textures, entry.record[field], { x: texture.width / ACTOR_COLUMNS * ACTOR_STANDING_COLUMN, y: 0, width: texture.width / ACTOR_COLUMNS, height: texture.height / ACTOR_ROWS }, field)
    })
    classWorld[entry.id] = { kind: entry.kind, name: entry.name, database: { name: 'job', id: entry.record.ID, recordName: entry.record.Name }, nativeRecord: entry.nativeRecord, rendering: { extraction: CLASS_WORLD_EXTRACTION, sourceTextures: sources } }
  }
  const menuIcons = {}
  const icon = (key, texturePath, index, locator) => {
    const texture = textures.get(texturePath)
    if (!texture) throw new Error(`Native menu texture is absent: ${texturePath}`)
    menuIcons[key] = { name: key.slice(key.indexOf(':') + 1), locator, rendering: { extraction: MENU_ICON_EXTRACTION, sourceTextures: [textureSource(textures, texturePath, gameIconRegion(index, texture))] } }
  }
  for (const [key, path, index, locator] of MENU_CELL_SOURCES) icon(key, path, index, locator)
  const scroll = snapshot.databases.item.find(record => record?.ID === SCROLL_ITEM_ID)
  if (scroll?.Name !== 'Scroll') throw new Error('Native Scroll menu identity changed')
  icon('skill:scroll', scroll.TexturePath, scroll.TextureIndex, `Database/item.dat record ${SCROLL_ITEM_ID}; WindowHelper.DrawAbilityIcon consumed-item icon`)
  for (const job of snapshot.databases.job.filter(record => record && MENU_COMMAND_JOB_IDS.has(record.ID))) {
    if (typeof job.AbilitiesName !== 'string' || !job.AbilitiesName) throw new Error(`Native command name is absent: ${job.ID}`)
    icon(`command:${job.AbilitiesName.toLowerCase()}`, job.IconTexturePath, job.IconTextureIndex, `Database/job.dat record ${job.ID}; IconTexturePath and IconTextureIndex; WindowJobDetails.Draw`)
  }
  return { classWorld, menuIcons }
}

export function validateNativeReferenceArtwork(manifest, snapshot, textures) {
  for (const [group, plans] of Object.entries(nativeReferenceArtworkPlans(snapshot, textures))) {
    if (JSON.stringify(Object.keys(manifest[group] ?? {})) !== JSON.stringify(Object.keys(plans))) throw new Error(`Native ${group} artwork coverage is invalid`)
    for (const [key, plan] of Object.entries(plans)) {
      const { asset: assetId, ...binding } = manifest[group][key]
      const asset = manifest.assets[assetId]
      const sources = plan.rendering.sourceTextures
      const width = group === 'menuIcons' ? MENU_ICON_SIZE : sources.reduce((total, source) => total + source.region.width, 0)
      const height = group === 'menuIcons' ? MENU_ICON_SIZE : Math.max(...sources.map(source => source.region.height))
      if (JSON.stringify(binding) !== JSON.stringify(plan) || !asset || asset.width !== width || asset.height !== height || !asset.extractions.includes(plan.rendering.extraction) || sources.some(source => !asset.sourceTextures.some(candidate => JSON.stringify(candidate) === JSON.stringify(source)))) throw new Error(`Native ${group} artwork binding is stale: ${key}`)
    }
  }
}

export function validateNativeUiArtwork(manifest, textures) {
  if (JSON.stringify(Object.keys(manifest.uiArtwork ?? {})) !== JSON.stringify(Object.keys(NATIVE_UI_ARTWORK))) throw new Error('Native UI artwork coverage is invalid')
  for (const [key, source] of Object.entries(NATIVE_UI_ARTWORK)) {
    const binding = manifest.uiArtwork[key]
    const asset = manifest.assets[binding?.asset]
    if (!binding || !asset || binding.label !== source.label) throw new Error(`Native UI artwork binding is invalid: ${key}`)
    if (source.entityId) {
      const entity = manifest.entities[source.entityId]
      if (!entity || binding.entityId !== source.entityId || binding.asset !== entity.asset) throw new Error(`Native UI artwork entity binding is stale: ${key}`)
      continue
    }
    const texture = textures.get(source.texturePath)
    if (!texture) throw new Error(`Native UI artwork texture is absent: ${source.texturePath}`)
    validateRegion(source.region, texture, `Native UI artwork ${key}`)
    const expectedSource = { texturePath: source.texturePath, textureSha256: texture.sha256, region: source.region }
    if (binding.entityId !== undefined || asset.width !== source.region.width || asset.height !== source.region.height || JSON.stringify(binding.rendering) !== JSON.stringify({ extraction: CURRENCY_ARTWORK_EXTRACTION, sourceTextures: [expectedSource] }) || !asset.sourceTextures.some(entry => JSON.stringify(entry) === JSON.stringify(expectedSource)) || !asset.extractions.includes(CURRENCY_ARTWORK_EXTRACTION)) throw new Error(`Native UI artwork crop is stale: ${key}`)
  }
}

export function nativeArtworkEntries(snapshot) {
  const files = new Map(snapshot.source.files.map(file => [file.path, file]))
  return Object.values(buildNativeCatalog(snapshot).entities).filter(entity => nativeIdentity(entity) && nativeSourceRecord(entity)).map(entity => {
    const identity = nativeIdentity(entity)
    const file = identity.mode === 'base' ? `Database/${identity.database}.dat` : 'Database/patch.dat'
    return {
      id: entity.id, kind: entity.kind, name: entity.name,
      record: nativeSourceRecord(entity),
      nativeRecord: { ...identity, locator: entity.sources[0].locator, databaseSha256: files.get(file).sha256 },
    }
  })
}

export function nativeArtworkPlan(entry, textures) {
  const record = entry.record
  const family = entry.nativeRecord.database
  const source = (path, region, field) => {
    const texture = textures.get(path)
    if (!texture) throw new Error(`Native artwork texture is absent: ${path}`)
    validateRegion(region, texture, `Native artwork ${entry.id}`)
    return { ...(field ? { field } : {}), texturePath: path, textureSha256: texture.sha256, region }
  }
  if (family === 'job') {
    const variants = ['ActorTexturePathM', 'ActorTexturePathF']
    if (variants.some(field => typeof record[field] !== 'string' || !record[field])) return undefined
    const sources = variants.map(field => {
      const texture = textures.get(record[field])
      if (!texture) throw new Error(`Native artwork texture is absent: ${record[field]}`)
      return source(record[field], actorIconRegion(texture), field)
    })
    return { type: 'class', extraction: 'paired actor-sheet class icons', sourceTextures: sources }
  }
  if (typeof record.TexturePath !== 'string' || !record.TexturePath) return undefined
  const texture = textures.get(record.TexturePath)
  if (!texture) throw new Error(`Native artwork texture is absent: ${record.TexturePath}`)
  if (INDEXED_FAMILIES.has(family)) {
    return { type: 'icon', extraction: '32x32 indexed game icon cell', sourceTextures: [source(record.TexturePath, gameIconRegion(record.TextureIndex, texture))] }
  }
  if (family === 'monster') {
    return { type: 'monster', extraction: 'named monster texture', sourceTextures: [source(record.TexturePath, { x: 0, y: 0, width: texture.width, height: texture.height })] }
  }
  return undefined
}

export function validateNativeArtworkCoverage(manifest, entries, textures) {
  if (!Array.isArray(manifest.coverage?.nativeDefinitionGaps)) throw new Error('Native definition artwork coverage is absent')
  const gaps = new Map()
  for (const gap of manifest.coverage.nativeDefinitionGaps) {
    if (gaps.has(gap.id)) throw new Error(`Duplicate native definition artwork gap: ${gap.id}`)
    gaps.set(gap.id, gap)
  }
  const bound = new Set()
  for (const entry of entries) {
    const plan = nativeArtworkPlan(entry, textures)
    const binding = manifest.entities[entry.id]
    if (!plan) {
      const expected = { id: entry.id, kind: entry.kind, name: entry.name, nativeRecord: entry.nativeRecord, reason: NO_NATIVE_ARTWORK }
      if (JSON.stringify(gaps.get(entry.id)) !== JSON.stringify(expected) || binding?.nativeRecord) throw new Error(`Native definition artwork gap is stale: ${entry.id}`)
      gaps.delete(entry.id)
      continue
    }
    if (!binding || binding.kind !== entry.kind || (!binding.identity && binding.name !== entry.name) || JSON.stringify(binding.nativeRecord) !== JSON.stringify(entry.nativeRecord) || binding.database?.name !== entry.nativeRecord.database || binding.database.id !== entry.record.ID || binding.database.recordName !== entry.record.Name || JSON.stringify(binding.rendering) !== JSON.stringify({ extraction: plan.extraction, sourceTextures: plan.sourceTextures })) throw new Error(`Native definition artwork binding is stale: ${entry.id}`)
    if (plan.type === 'monster' && binding.asset !== plan.sourceTextures[0].textureSha256) throw new Error(`Native monster artwork differs from its full texture: ${entry.id}`)
    bound.add(entry.id)
  }
  if (gaps.size || Object.entries(manifest.entities).some(([id, binding]) => binding.nativeRecord && !bound.has(id))) throw new Error('Native definition artwork coverage contains unknown identities')
}
