import { expect, it } from 'vitest'
import { requireGuestRestoreJournal } from '../workspace/guest-coordinator'

const id = 'e331046e-b773-49fd-a671-fec5bde039b4'
const expected = { version: 1, id: 'before', revision: 0, planner: 'old-planner', inspector: 'old-inspector', files: 'old-files' }
const target = { version: 2, id, revision: 1, planner: `crykit-restored-v2-${id}-planner`, inspector: `crykit-restored-v2-${id}-inspector`, files: `crykit-restored-v2-${id}-files` }
const capture = { id: 'frozen', version: 1, completed: true, participants: [
  { kind: 'planner', name: expected.planner, tables: ['localDatas'] },
  { kind: 'inspector', name: expected.inspector, tables: ['drafts'] },
  { kind: 'files', name: expected.files, tables: ['documents'] },
] }
const row = { version: 2, kind: 'guest-restore', id, expected, target, capture, phase: 'registered', ownerGeneration: 0, sourceVectorDigest: 'a'.repeat(64), snapshotDigest: 'b'.repeat(64), acquired: [], recovery: 'unchecked' }

it('admits a registered restore only with its exact v2 target namespace and source association', () => {
  expect(requireGuestRestoreJournal(row)).toEqual(row)
  expect(() => requireGuestRestoreJournal({ ...row, target: { ...target, planner: `crykit-profile-${id}-planner` } })).toThrow()
  expect(() => requireGuestRestoreJournal({ ...row, target: { ...target, id: 'another' } })).toThrow()
  expect(() => requireGuestRestoreJournal({ ...row, capture: { ...capture, participants: [{ ...capture.participants[0], name: 'another' }, ...capture.participants.slice(1)] } })).toThrow()
  expect(() => requireGuestRestoreJournal({ ...row, extra: true })).toThrow()
})
