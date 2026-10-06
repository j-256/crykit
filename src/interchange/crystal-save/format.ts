export const CRYSTAL_SAVE_VERSION = 28

export const CRYSTAL_SAVE_MIN_VERSION = 0

export function crystalSaveVersion(storedVersion: number): number {
  // Only the earliest layouts use the complemented version byte
  const legacyVersion = 255 - storedVersion
  return legacyVersion >= 1 && legacyVersion <= 3 ? legacyVersion : storedVersion
}

export function isSupportedCrystalSaveVersion(version: number): boolean {
  return Number.isInteger(version) && version >= CRYSTAL_SAVE_MIN_VERSION && version <= CRYSTAL_SAVE_VERSION
}

export const CRYSTAL_SAVE_LIMITS = Object.freeze({
  maxFileBytes: 64 * 1024 * 1024,
  maxStringBytes: 4 * 1024 * 1024,
  maxDocumentBytes: 32 * 1024 * 1024,
  maxDepth: 64,
  maxNodes: 1_000_000,
  maxMaps: 4096,
  maxMods: 4096,
  maxModMappings: 1_000_000,
})

export const MEMBER_COUNT = 4

export const FORMAT = Object.freeze({ demo: 4, difficulty: 12, flags: 14, newGamePlus: 16, patchMode: 17, hardcore: 21, mods: 24, modIds: 25, animationIds: 27, savedDate: 28 })

// Version and the version-gated booleans stay outside the XOR-obfuscated payload
export function prefixBytes(version: number): number { return 1 + Number(version >= FORMAT.demo) + Number(version >= FORMAT.hardcore) }

export const MAX_INT32 = 0x7fffffff
