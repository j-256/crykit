import { expect, it, vi } from 'vitest'
import type { WorkspaceRepository } from '../workspace/repository'
import type { WorkspaceSnapshot } from '../workspace/snapshot'

it.each([true, false])('rejects profile changes while optional backup code loads (capture=%s)', async capture => {
  vi.resetModules()
  let releaseImport!: () => void
  let reportImport!: () => void
  const paused = new Promise<void>(resolve => { releaseImport = resolve })
  const requested = new Promise<void>(resolve => { reportImport = resolve })
  const captureSnapshot = vi.fn(), disposeSnapshot = vi.fn(), encode = vi.fn()
  vi.doMock('../workspace/snapshot', async () => {
    reportImport()
    await paused
    return { captureWorkspaceSnapshot: captureSnapshot, disposeWorkspaceSnapshot: disposeSnapshot, assertWorkspaceSnapshotCurrent: vi.fn() }
  })
  vi.doMock('../interchange/workspace-backup', () => ({ exportWorkspaceBackup: encode }))
  const sink = { write: vi.fn(), close: vi.fn(), abort: vi.fn(async () => {}) }
  const picker = vi.fn(async () => ({ createWritable: async () => sink }))
  vi.stubGlobal('showSaveFilePicker', picker)
  let operation: Promise<void> | undefined
  try {
    const { downloadCapturedWorkspace, downloadWorkspaceBackup } = await import('./download-stream')
    const { invalidateProfile } = await import('../account/profile')
    const flush = vi.fn(async () => {})
    // These sentinels must remain unread: the old profile loses ownership before capture or encoding
    operation = capture ? downloadCapturedWorkspace({} as WorkspaceRepository, flush) : downloadWorkspaceBackup({} as WorkspaceSnapshot)
    expect(picker).toHaveBeenCalledOnce()
    await requested
    expect(flush).toHaveBeenCalledTimes(capture ? 1 : 0)
    const rejected = expect(operation).rejects.toThrow('PROFILE_CHANGED')
    invalidateProfile()
    releaseImport()
    await rejected
    expect(captureSnapshot).not.toHaveBeenCalled()
    expect(encode).not.toHaveBeenCalled()
    expect(sink.write).not.toHaveBeenCalled()
    expect(sink.close).not.toHaveBeenCalled()
    expect(sink.abort).toHaveBeenCalledOnce()
    expect(disposeSnapshot).not.toHaveBeenCalled()
  } finally {
    releaseImport()
    await operation?.catch(() => {})
    vi.doUnmock('../workspace/snapshot')
    vi.doUnmock('../interchange/workspace-backup')
    vi.unstubAllGlobals()
  }
})
