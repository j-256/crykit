import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })
it('guestCanImportPasswordAdapterWithoutWebAssembly', async () => {
  vi.resetModules()
  vi.stubGlobal('WebAssembly', undefined)
  const opaque = await import('./opaque')
  expect(opaque.opaqueKeyStretching['argon2id-custom']).toEqual({ memory: 65536, iterations: 2, parallelism: 1 })
  // A deliberate password operation owns the failure; importing the guest dependency does not
  await expect(opaque.startLogin('synthetic valid password')).rejects.toThrow()
})
