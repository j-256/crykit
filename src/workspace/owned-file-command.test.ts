import { expect, it } from 'vitest'
import { newOwnedFileCommand, ownedFileReceipt, resolveOwnedFileReceipt } from './owned-file-command'
import type { WorkspaceRepository } from './repository'
import type { WorkspaceState } from './documents'

it('rechecks command owner authority after the final receipt fence await', async () => {
  let blocked = false
  const command = newOwnedFileCommand('import', () => { if (blocked) throw new Error('Another owner became dirty') })
  const receipt = ownedFileReceipt(command, async () => ({
    repository: {} as WorkspaceRepository,
    state: {} as WorkspaceState,
    assertCurrent: async () => { await Promise.resolve(); blocked = true },
  }))
  await expect(resolveOwnedFileReceipt(receipt)).rejects.toThrow('Another owner became dirty')
})
