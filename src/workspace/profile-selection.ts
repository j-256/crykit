import type { ProfileToken } from '../account/profile'

export type WorkspaceSelection = { readonly kind: 'guest'; readonly generation: number } | { readonly kind: 'account'; readonly token: ProfileToken } | { readonly kind: 'locked' | 'opening'; readonly generation: number }

// Account route preferences are volatile and profile-scoped; guest preferences retain their legacy storage
// Never persist private account search text in the guest browser-selection stores
let accountSelected = false
const accountPreferences = new Map<string, string>()
export function selectAccountPreferences(value: boolean): void { accountSelected = value; accountPreferences.clear() }
export function readSelectionPreference(key: string): string | null {
  return accountSelected ? accountPreferences.get(key) ?? null : window.sessionStorage.getItem(key)
}
export function writeSelectionPreference(key: string, value: string): void {
  if (accountSelected) accountPreferences.set(key, value)
  else window.sessionStorage.setItem(key, value)
}
export function workspaceSelectionKey(selection: WorkspaceSelection): string {
  return selection.kind === 'account' ? `account:${selection.token.accountId}:${selection.token.generation}` : `${selection.kind}:${selection.generation}`
}

const TAB_SELECTION_KEY = 'crykit-workspace-access-v1'
export function readTabWorkspaceAccess(): string | null {
  try { return window.sessionStorage.getItem(TAB_SELECTION_KEY) } catch { return null }
}
export function tabIsExplicitlyLocked(): boolean { return readTabWorkspaceAccess() === 'account-locked' }
export function markWorkspaceAccess(mode: 'account-open' | 'account-locked' | 'guest'): void {
  try { window.sessionStorage.setItem(TAB_SELECTION_KEY, mode) } catch { /* Unavailable tab storage cannot grant unlock authority */ }
}
