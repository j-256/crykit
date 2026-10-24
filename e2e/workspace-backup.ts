import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { indexedDB, IDBKeyRange } from 'fake-indexeddb'
import { readWorkspaceBackup } from '../src/interchange/workspace-backup'
import { disposeWorkspaceSnapshot } from '../src/workspace/snapshot'
import { memoryBlob } from '../src/workspace/blobs'

// Other test modules can initialize Dexie before auto installs the Node globals
Dexie.dependencies.indexedDB = indexedDB
Dexie.dependencies.IDBKeyRange = IDBKeyRange

export async function readCompleteBackup(bytes: Uint8Array) {
  const snapshot = await readWorkspaceBackup(memoryBlob(bytes).open())
  try {
    // The reader has already validated every lazy body; return portable assertions before releasing staging
    const { blobs: _blobs, ...metadata } = snapshot.state
    return metadata
  } finally { await disposeWorkspaceSnapshot(snapshot) }
}
