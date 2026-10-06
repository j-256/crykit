import { type CrystalSaveHeader } from './types.ts'
import { Reader, Writer } from './binary.ts'
import { crystalSaveVersion, isSupportedCrystalSaveVersion, CRYSTAL_SAVE_MIN_VERSION, CRYSTAL_SAVE_VERSION, FORMAT, MEMBER_COUNT, CRYSTAL_SAVE_LIMITS } from './format.ts'
import { CrystalSaveError } from './error.ts'

const MOD_GROUPS = ['abilities', 'animations', 'biomes', 'difficulties', 'equipment', 'genders', 'items', 'jobs', 'monsters', 'passives', 'recipes', 'sparks', 'statuses', 'troops', 'entities'] as const

function validDate(value: CrystalSaveHeader['lastUpdated']): boolean {
  if (!value) return false
  const { year, month, day, hour, minute, second } = value
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return year >= 1 && year <= 9999 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] && hour >= 0 && hour < 24 && minute >= 0 && minute < 60 && second >= 0 && second < 60
}

export function readHeader(reader: Reader): CrystalSaveHeader {
  const storedVersion = reader.byte()
  const version = crystalSaveVersion(storedVersion)
  if (!isSupportedCrystalSaveVersion(version)) reader.fail(`Unsupported save format ${version}; the native reader supports formats ${CRYSTAL_SAVE_MIN_VERSION} to ${CRYSTAL_SAVE_VERSION}`)
  const invertedVersion = storedVersion !== version
  const isDemo = version >= FORMAT.demo ? reader.boolean() : false
  const isHardcoreDefeat = version >= FORMAT.hardcore ? reader.boolean() : false
  const playTime = { days: reader.int32(), hours: reader.int32(), minutes: reader.int32(), seconds: reader.int32(), milliseconds: reader.int32() }
  const lastUpdated = version >= FORMAT.savedDate ? { year: reader.int32(), month: reader.int32(), day: reader.int32(), hour: reader.int32(), minute: reader.int32(), second: reader.int32() } : null
  if (lastUpdated && !validDate(lastUpdated)) reader.fail('Invalid save header date')
  const homePointName = reader.string()
  const currencyAmount = reader.int32()
  if (reader.int32() !== MEMBER_COUNT) reader.fail(`Save format requires ${MEMBER_COUNT} party member slots`)
  const members = Array.from({ length: MEMBER_COUNT }, () => ({ isPresent: reader.boolean(), name: reader.string(), level: reader.int32(), genderId: reader.int32(), jobId: reader.int32() }))
  const difficultyId = version >= FORMAT.difficulty ? reader.int32() : -1
  const patchMode = version >= FORMAT.patchMode ? reader.byte() : 0
  let assistFlags = 0
  if (version >= FORMAT.flags) assistFlags = reader.int32()
  else if (version >= FORMAT.difficulty) for (let bit = 0; bit < 7; bit++) if (reader.boolean()) assistFlags |= 1 << bit
  const challengeFlags = version >= FORMAT.flags ? reader.int32() : 0
  const randomizerFlags = version >= FORMAT.flags ? reader.int32() : 0
  const newGamePlusCount = version >= FORMAT.newGamePlus ? reader.int32() : 0
  const isModded = version >= FORMAT.mods ? reader.boolean() : false
  const mods = version >= FORMAT.mods ? Array.from({ length: reader.count(CRYSTAL_SAVE_LIMITS.maxMods, 'mod', version >= FORMAT.modIds ? 11 : 3) }, () => ({ id: reader.string(), title: reader.string(), version: reader.string(), steamWorkshopFileId: version >= FORMAT.modIds ? reader.int64(true) : 0n })) : []
  let totalMappings = 0
  const modIdMaps = version >= FORMAT.modIds ? Array.from({ length: reader.count(CRYSTAL_SAVE_LIMITS.maxMods, 'mod ID map', version >= FORMAT.animationIds ? 61 : 57) }, () => {
    const modId = reader.string()
    const groups: CrystalSaveHeader['modIdMaps'][number]['groups'] = Object.create(null)
    for (const group of MOD_GROUPS) {
      if (group === 'animations' && version < FORMAT.animationIds) { groups[group] = []; continue }
      const count = reader.count(CRYSTAL_SAVE_LIMITS.maxModMappings - totalMappings, 'mod mapping', 8)
      totalMappings += count
      groups[group] = Array.from({ length: count }, () => ({ originalId: reader.int32(), newId: reader.int32() }))
    }
    return { modId, groups }
  }) : []
  return { version, invertedVersion, isDemo, isHardcoreDefeat, playTime, lastUpdated, homePointName, currencyAmount, members, difficultyId, patchMode, assistFlags, challengeFlags, randomizerFlags, newGamePlusCount, isModded, mods, modIdMaps }
}

export function writeHeader(writer: Writer, header: CrystalSaveHeader): void {
  const version = header.version
  if (!isSupportedCrystalSaveVersion(version) || header.members.length !== MEMBER_COUNT || (version >= FORMAT.savedDate && !validDate(header.lastUpdated)) || (header.invertedVersion && (version < 1 || version > 3))) throw new CrystalSaveError('Invalid save header')
  // Refuse lossy exports instead of silently upgrading or dropping fields from an older layout
  const unsupportedValues = [
    version < FORMAT.demo && header.isDemo,
    version < FORMAT.hardcore && header.isHardcoreDefeat,
    version < FORMAT.difficulty && header.difficultyId !== -1,
    version < FORMAT.patchMode && header.patchMode !== 0,
    version < FORMAT.flags && (header.challengeFlags !== 0 || header.randomizerFlags !== 0 || header.assistFlags > (version >= FORMAT.difficulty ? 127 : 0) || header.assistFlags < 0),
    version < FORMAT.newGamePlus && header.newGamePlusCount !== 0,
    version < FORMAT.mods && (header.isModded || header.mods.length > 0),
    version < FORMAT.modIds && header.modIdMaps.length > 0,
    version < FORMAT.savedDate && header.lastUpdated !== null,
  ]
  if (unsupportedValues.some(Boolean)) throw new CrystalSaveError('Header values cannot be represented in the original save format')
  if (version < FORMAT.modIds && header.mods.some(mod => mod.steamWorkshopFileId !== 0n) || version < FORMAT.animationIds && header.modIdMaps.some(map => (map.groups.animations?.length ?? 0) > 0)) throw new CrystalSaveError('Mod metadata cannot be represented in the original save format')
  writer.byte(header.invertedVersion ? 255 - version : version)
  if (version >= FORMAT.demo) writer.boolean(header.isDemo)
  if (version >= FORMAT.hardcore) writer.boolean(header.isHardcoreDefeat)
  for (const field of ['days', 'hours', 'minutes', 'seconds', 'milliseconds'] as const) writer.int32(header.playTime[field])
  if (version >= FORMAT.savedDate) for (const field of ['year', 'month', 'day', 'hour', 'minute', 'second'] as const) writer.int32(header.lastUpdated![field])
  writer.string(header.homePointName)
  writer.int32(header.currencyAmount)
  writer.int32(header.members.length)
  for (const member of header.members) {
    writer.boolean(member.isPresent)
    writer.string(member.name)
    writer.int32(member.level)
    writer.int32(member.genderId)
    writer.int32(member.jobId)
  }
  if (version >= FORMAT.difficulty) writer.int32(header.difficultyId)
  if (version >= FORMAT.patchMode) writer.byte(header.patchMode)
  if (version >= FORMAT.flags) {
    writer.int32(header.assistFlags)
    writer.int32(header.challengeFlags)
    writer.int32(header.randomizerFlags)
  } else if (version >= FORMAT.difficulty) for (let bit = 0; bit < 7; bit++) writer.boolean(Boolean(header.assistFlags & (1 << bit)))
  if (version >= FORMAT.newGamePlus) writer.int32(header.newGamePlusCount)
  if (header.mods.length > CRYSTAL_SAVE_LIMITS.maxMods || header.modIdMaps.length > CRYSTAL_SAVE_LIMITS.maxMods) throw new CrystalSaveError('Save exceeds the mod count limit')
  if (version >= FORMAT.mods) {
    writer.boolean(header.isModded)
    writer.int32(header.mods.length)
    for (const mod of header.mods) { writer.string(mod.id); writer.string(mod.title); writer.string(mod.version); if (version >= FORMAT.modIds) writer.int64(mod.steamWorkshopFileId, true) }
  }
  if (version < FORMAT.modIds) return
  writer.int32(header.modIdMaps.length)
  let totalMappings = 0
  for (const map of header.modIdMaps) {
    writer.string(map.modId)
    if (Object.keys(map.groups).some(group => !MOD_GROUPS.includes(group as typeof MOD_GROUPS[number]))) throw new CrystalSaveError('Unknown mod ID mapping group')
    for (const group of MOD_GROUPS) {
      if (group === 'animations' && version < FORMAT.animationIds) continue
      const pairs = map.groups[group] ?? []
      totalMappings += pairs.length
      if (totalMappings > CRYSTAL_SAVE_LIMITS.maxModMappings) throw new CrystalSaveError('Save exceeds the mod mapping count limit')
      writer.int32(pairs.length)
      for (const pair of pairs) { writer.int32(pair.originalId); writer.int32(pair.newId) }
    }
  }
}
