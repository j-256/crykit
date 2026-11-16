import { z } from 'zod'
import { OpaqueIdSchema } from './protocol'

export const SHARE_ID_LENGTH = 11
export const SHARE_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
// Short public locators are not credentials; legacy IDs retain their canonical padding-bit check
export const ShareIdSchema = z.union([z.string().length(SHARE_ID_LENGTH).regex(/^[A-Za-z0-9_-]+$/), OpaqueIdSchema])
export type HostedShareKind = 'build' | 'team'
export function hostedSharePath(id: string, kind?: HostedShareKind): string {
  if (kind !== undefined && kind !== 'build' && kind !== 'team') throw new Error('Invalid hosted share kind')
  return `/${kind === 'build' ? 'b' : kind === 'team' ? 't' : 's'}/${ShareIdSchema.parse(id)}`
}
