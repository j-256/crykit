import type sodiumType from 'libsodium-wrappers-sumo'
import type { StateAddress } from 'libsodium-wrappers-sumo'
import { streamOverheadBytes } from '../protocol'
import { recordWorkspaceStartup, WORKSPACE_STARTUP_PHASE } from '../../diagnostics/workspace-startup'

let ready: Promise<typeof sodiumType> | undefined
export function getSodium(): Promise<typeof sodiumType> {
  // Lazy loading keeps guest startup independent of the crypto runtime
  ready ??= import('libsodium-wrappers-sumo').then(async ({ default: sodium }) => {
    recordWorkspaceStartup(WORKSPACE_STARTUP_PHASE.sodiumImported)
    await sodium.ready
    recordWorkspaceStartup(WORKSPACE_STARTUP_PHASE.sodiumReady)
    if (sodium.crypto_secretstream_xchacha20poly1305_ABYTES !== streamOverheadBytes) throw new Error('Unsupported secretstream runtime')
    return sodium
  })
  return ready
}

interface PinnedSodiumHeap {
  readonly HEAPU8: Uint8Array
  _crypto_secretstream_xchacha20poly1305_statebytes(): number
  _free(address: number): void
}

export function releaseStreamState(sodium: typeof sodiumType, state: StateAddress): void {
  // 0.8.4 returns a malloc-owned numeric address despite its StateAddress object declaration
  // The wrapper has no destroy API: clear the pinned runtime's state before freeing it
  const address: unknown = state
  if (typeof address !== 'number') throw new Error('Unsupported secretstream state handle')
  const raw = (sodium as unknown as { libsodium: PinnedSodiumHeap }).libsodium
  raw.HEAPU8.fill(0, address, address + raw._crypto_secretstream_xchacha20poly1305_statebytes())
  raw._free(address)
}

export function encodeBytes(sodium: typeof sodiumType, value: Uint8Array): string {
  return sodium.to_base64(value, sodium.base64_variants.URLSAFE_NO_PADDING)
}
export function decodeBytes(sodium: typeof sodiumType, value: string): Uint8Array {
  return sodium.from_base64(value, sodium.base64_variants.URLSAFE_NO_PADDING)
}
