import type { ProfileToken } from '../account/profile'
import type { AccountDatabase, CipherRef } from '../persistence/account-database'
import { createAccountInheritedEvidencePreparation, openAccountInheritedEvidence, type PreparedAccountInheritedEvidence } from './account-evidence-snapshots'

export async function accountEvidenceContains(database: AccountDatabase, token: ProfileToken, whole: CipherRef, part: CipherRef): Promise<boolean> {
  const left = await openAccountInheritedEvidence(database, token, whole)
  try {
    const right = await openAccountInheritedEvidence(database, token, part)
    try {
      const members = new Set(left.members.map(value => value.id))
      await left.check(); await right.check()
      return right.members.every(value => members.has(value.id))
    } finally { await right.dispose() }
  } finally { await left.dispose() }
}

export async function prepareAccountEvidenceUnion(database: AccountDatabase, token: ProfileToken, local: CipherRef, remote: CipherRef): Promise<{ prepared: PreparedAccountInheritedEvidence; dispose(): Promise<void> }> {
  const left = await openAccountInheritedEvidence(database, token, local)
  let right: Awaited<ReturnType<typeof openAccountInheritedEvidence>> | undefined
  const operation = createAccountInheritedEvidencePreparation(database, token)
  try {
    right = await openAccountInheritedEvidence(database, token, remote)
    const prepared = await operation.prepare({ base: left, merge: right })
    return { prepared, async dispose() {
      const results = await Promise.allSettled([operation.abandon(), left.dispose(), right?.dispose()])
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (failures.length) throw new AggregateError(failures, 'Account evidence union cleanup failed')
    } }
  } catch (error) {
    const results = await Promise.allSettled([operation.abandon(), left.dispose(), right?.dispose()])
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length) throw new AggregateError([error, ...failures], 'Account evidence union and cleanup failed')
    throw error
  }
}
