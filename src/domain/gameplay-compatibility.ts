export const CONSOLE_BASELINE_VERSIONS: readonly string[] = Object.freeze(['1.6.6', '1.6.6.0'])
export const LEGACY_RESOURCE_TIMING_VERSIONS: readonly string[] = Object.freeze(['1.6.9', '1.6.9.0', ...CONSOLE_BASELINE_VERSIONS])
// Pin reviewed source coverage so a future catalog refresh cannot silently extend Switch parity
export const SUPPORTED_NATIVE_GAME_VERSIONS: readonly string[] = Object.freeze(['1.7.0.1', ...LEGACY_RESOURCE_TIMING_VERSIONS])
const PC_PLATFORMS = new Set(['windows', 'macos', 'linux', 'pc'])
const SWITCH_PLATFORM = 'nintendo switch'

export function isPCPlatform(platform: string): boolean {
  return PC_PLATFORMS.has(platform.toLowerCase())
}

export function supportsNativeGameplayPlatform(platform: string, version: string | undefined): boolean {
  // The inspected PC console branch is the approved Switch proxy only for exact 1.6.6 versions
  // A missing Switch version cannot select either the legacy or the 1.7 resource semantics
  return isPCPlatform(platform) || platform.toLowerCase() === SWITCH_PLATFORM && version !== undefined && CONSOLE_BASELINE_VERSIONS.includes(version)
}

export function supportsNativeGameplayScope(platform: string, version: string): boolean {
  return supportsNativeGameplayPlatform(platform, version) && SUPPORTED_NATIVE_GAME_VERSIONS.includes(version)
}
