import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import { createRememberedEnvelope, openRememberedEnvelope, readDeviceProfile, updateDeviceProfile } from './device-store'
const accountId = 'EEEEEEEEEEEEEEEEEEEEEA'
it('persistsNonextractableAccountBoundRememberedMaterial', async () => {
  const remembered = await createRememberedEnvelope(new Uint8Array(32).fill(9), accountId)
  await updateDeviceProfile(accountId, state => ({ ...state, remembered }))
  const stored = (await readDeviceProfile(accountId))!.remembered!
  expect(stored.deviceKey.extractable).toBe(false)
  expect(await openRememberedEnvelope(stored, accountId)).toEqual(new Uint8Array(32).fill(9))
  await expect(openRememberedEnvelope(stored, 'FFFFFFFFFFFFFFFFFFFFFA')).rejects.toThrow()
})
it('failedEncryptedLocalWritePreservesPriorEnvelope', async () => {
  const before = await readDeviceProfile(accountId)
  await expect(updateDeviceProfile(accountId, state => ({ ...state, pendingRevocations: ['BBBBBBBBBBBBBBBBBBBBBA'] }), () => { throw new Error('PROFILE_CHANGED') })).rejects.toThrow('PROFILE_CHANGED')
  expect(await readDeviceProfile(accountId)).toEqual(before)
})
