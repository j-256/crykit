import { assertActiveProfile, currentProfileToken } from '../../src/account/profile'
import { activateLocalAccountCommit, AccountDatabase } from '../../src/persistence/account-database'
import { accountLocalId } from '../../src/workspace/account-cache'
import { prepareAccountWorkspace } from '../../src/workspace/account-graph'
import { writeDeviceSelection } from '../../src/workspace/device-selection'
import { editorClosureFixture } from '../../src/workspace/test-helpers'

// Only explicit synthetic qualification loads this module, so ordinary Merge fixtures do not warm it
export async function seedSelectedNativeAccount() {
  const token = currentProfileToken()!, database = new AccountDatabase(token.accountId)
  try {
    if (await database.profileMeta.get('active')) throw new Error('Native startup qualification requires fresh storage')
    const fixture = await editorClosureFixture()
    const state = { ...fixture.state, editorDocuments: [fixture.file] }
    const prepared = await prepareAccountWorkspace(database, token, state)
    await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: undefined, head: prepared.head, records: prepared.records })
    // Normal remembered startup must encounter this genuine selected native root itself
    // The fixture admission mount rewrites selection to guest and would bypass that public contract
    await writeDeviceSelection({ key: 'selected', version: 1, kind: 'account', accountId: token.accountId }, () => assertActiveProfile(token))
    return { originals: fixture.blobs.map(body => body.ref) }
  } finally { database.close() }
}
