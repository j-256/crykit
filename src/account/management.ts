import { accountMetadata, changeUsername, startEmailChange, confirmEmailChange, replaceRecoveryCode, reauthenticateAccount } from './auth-client'
import { approveDevice, getApprovalRequest, listApprovalRequests, listDevices, rejectDeviceApproval, removeDevice } from './device-approval'
import { assertActiveProfile, profileSignal, withProfileSession, type ProfileToken } from './profile'
import { updateOfflinePassword } from './lifecycle'
import { opaqueIdBytes, type ApprovalRequest } from './protocol'

const managed = withProfileSession
// Session and key material remain inside the infrastructure callback, including on failure
export async function readAccountView(token: ProfileToken) {
  return managed(token, async unlocked => {
    const metadata = await accountMetadata(unlocked, profileSignal(token))
    return { username: metadata.username, email: metadata.email, revision: metadata.revision, recoveryRevision: metadata.credentials.recoveryRevision, expiresAt: metadata.absoluteExpiresAt, access: metadata.access }
  })
}
export type AccountViewMetadata = Awaited<ReturnType<typeof readAccountView>>
export function accountTransactionId(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(opaqueIdBytes)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export const renameProfile = (token: ProfileToken, name: string, revision: number) => managed(token, unlocked => changeUsername(unlocked, name, accountTransactionId(), revision, profileSignal(token)))
export const changeProfileEmail = (token: ProfileToken, email: string, revision: number) => managed(token, unlocked => startEmailChange(unlocked, email, accountTransactionId(), revision, profileSignal(token)))
export const confirmProfileEmail = (token: ProfileToken, capability: string) => managed(token, unlocked => confirmEmailChange(unlocked, capability, profileSignal(token)))
export const createProfileRecovery = (token: ProfileToken, transactionId: string) => managed(token, unlocked => replaceRecoveryCode(unlocked, transactionId, profileSignal(token)))
export const reauthenticateProfile = (token: ProfileToken, secret: string, role: 'password' | 'recovery' = 'password') => managed(token, unlocked => reauthenticateAccount(unlocked, { role, secret }, profileSignal(token)))
export async function repairOfflinePassword(token: ProfileToken, password: string): Promise<void> {
  // Resume proves the original command only; fresh authentication proves this replacement input
  await reauthenticateProfile(token, password)
  assertActiveProfile(token)
  await updateOfflinePassword(token, password)
}
export const readProfileDevices = (token: ProfileToken, cursor?: string) => managed(token, unlocked => listDevices(unlocked, cursor, profileSignal(token)))
export const readProfileApprovals = (token: ProfileToken) => managed(token, unlocked => listApprovalRequests(unlocked, profileSignal(token)))
export const findProfileApproval = (token: ProfileToken, requestId: string) => managed(token, unlocked => getApprovalRequest(unlocked, requestId, profileSignal(token)))
export const approveProfileDevice = (token: ProfileToken, request: ApprovalRequest, fingerprint: string) => managed(token, unlocked => approveDevice(unlocked, request, fingerprint, profileSignal(token)))
export const rejectProfileApproval = (token: ProfileToken, requestId: string) => managed(token, unlocked => rejectDeviceApproval(unlocked, requestId, profileSignal(token)))
export const removeProfileDevice = (token: ProfileToken, deviceId: string) => managed(token, unlocked => removeDevice(unlocked, deviceId, profileSignal(token)))
