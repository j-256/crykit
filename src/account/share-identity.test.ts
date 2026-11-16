import { expect, it } from 'vitest'
import { OpaqueIdSchema } from './protocol'
import { ShareIdSchema, hostedSharePath } from './share-identity'
import { AdminCommandSchema, AdminListQuerySchema, AdminShareSummarySchema } from './admin-protocol'

it('accepts short public IDs and canonical legacy IDs without relaxing other opaque identities', () => {
  for (const id of ['Abc0123-_xy', 'AAAAAAAAAAAAAAAAAAAAAA']) expect(ShareIdSchema.parse(id)).toBe(id)
  for (const id of ['a'.repeat(10), 'a'.repeat(12), 'a'.repeat(21), 'a'.repeat(23), 'AAAAAAAAAAAAAAAAAAAAAB', 'Abc0123_./x', 'Abc0123%2Fx']) expect(ShareIdSchema.safeParse(id).success).toBe(false)
  expect(OpaqueIdSchema.safeParse('Abc0123-_xy').success).toBe(false)
  expect(hostedSharePath('Abc0123-_xy', 'build')).toBe('/b/Abc0123-_xy')
  expect(hostedSharePath('AAAAAAAAAAAAAAAAAAAAAA', 'team')).toBe('/t/AAAAAAAAAAAAAAAAAAAAAA')
  expect(hostedSharePath('Abc0123-_xy')).toBe('/s/Abc0123-_xy')
})

it('keeps short share IDs usable by moderation without widening account or mutation IDs', () => {
  const short = 'Abc0123-_xy', opaque = 'AAAAAAAAAAAAAAAAAAAAAA'
  expect(AdminListQuerySchema.parse({ shareId: short }).shareId).toBe(short)
  expect(AdminListQuerySchema.safeParse({ accountId: short }).success).toBe(false)
  expect(AdminShareSummarySchema.parse({ id: short, account_id: opaque, revision: 1, state: 'active', created_at: 1, updated_at: 1 }).id).toBe(short)
  const command = { version: 1, actionId: opaque, expectedRevision: 1, target: { kind: 'share', id: short }, reason: 'abuse', command: { type: 'shares.revoke' } }
  expect(AdminCommandSchema.safeParse(command).success).toBe(true)
  expect(AdminCommandSchema.safeParse({ ...command, actionId: short }).success).toBe(false)
  expect(AdminCommandSchema.safeParse({ ...command, target: { kind: 'account', id: short }, command: { type: 'accounts.block' } }).success).toBe(false)
})
