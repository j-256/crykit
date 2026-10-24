import { OpaqueIdSchema } from '../../account/protocol'

export const sections = ['overview', 'accounts', 'sharing', 'jobs', 'settings', 'access'] as const
export type Section = (typeof sections)[number]
type TargetKey = 'accountId' | 'shareId' | 'jobId'
const targets: Partial<Record<Section, TargetKey>> = {
  accounts: 'accountId',
  sharing: 'shareId',
  jobs: 'jobId',
}

export function parseAdminRoute(hash: string): {
  section: Section
  target: string | null
} {
  const fragment = hash.replace(/^#/, '')
  const divider = fragment.indexOf('?')
  const name = divider < 0 ? fragment : fragment.slice(0, divider)
  const query = divider < 0 ? '' : fragment.slice(divider + 1)
  const section = sections.find((item) => item === name) ?? 'overview'
  const expected = targets[section]
  if (!expected || !query) return { section, target: null }
  const params = new URLSearchParams(query)
  const entries = Array.from(params.entries())
  // Deep links select only an opaque target for the matching section, never a caller-supplied API path
  if (
    entries.length !== 1 ||
    entries[0][0] !== expected ||
    !OpaqueIdSchema.safeParse(entries[0][1]).success
  )
    return { section, target: null }
  return { section, target: entries[0][1] }
}

export function routeHash(section: Section, key?: TargetKey, id?: string): string {
  if (key && id && targets[section] === key && OpaqueIdSchema.safeParse(id).success)
    return `#${section}?${key}=${encodeURIComponent(id)}`
  return `#${section}`
}
