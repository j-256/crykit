import { expect, it, vi } from 'vitest'
import { readSelectionPreference, writeSelectionPreference, selectAccountPreferences } from './profile-selection'

it('starts guest route preferences independently without removing old selections or persisting account searches', () => {
  const rows = new Map([['reference-route', 'prelaunch-source-route']])
  const storage = { getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => rows.set(key, value) }
  vi.stubGlobal('window', { sessionStorage: storage })
  try {
    selectAccountPreferences(false)
    expect(readSelectionPreference('reference-route')).toBeNull()
    writeSelectionPreference('reference-route', 'launch-source-route')
    expect(readSelectionPreference('reference-route')).toBe('launch-source-route')
    expect(rows.get('reference-route')).toBe('prelaunch-source-route')
    const guest = new Map(rows)
    selectAccountPreferences(true)
    writeSelectionPreference('reference-route', 'private-account-search')
    expect(readSelectionPreference('reference-route')).toBe('private-account-search')
    expect(rows).toEqual(guest)
    selectAccountPreferences(false)
    expect(readSelectionPreference('reference-route')).toBe('launch-source-route')
  } finally { selectAccountPreferences(false); vi.unstubAllGlobals() }
})
