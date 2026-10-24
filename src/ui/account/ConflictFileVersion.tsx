import { useEffect, useRef, useState } from 'react'
import { assertActiveProfile, type ProfileToken } from '../../account/profile'
import { sha256 } from '../../interchange/util'
import { NATIVE_BACKUP_ARCHIVE_LIMITS } from '../../interchange/zip'
import { blobIdentity, readBlob } from '../../workspace/blobs'
import type { WorkspaceBlobRef, WorkspaceDocument, WorkspaceState } from '../../workspace/documents'
import { EditorWorkspaceDocumentSchema, SaveWorkspaceDocumentSchema, WorkspaceAssetSchema } from '../../workspace/file-schemas'
import { downloadBytes } from '../model'

const PREVIEW_BYTES = 64 * 1024
interface ContentRole { readonly label: string; readonly ref: WorkspaceBlobRef }
function escapedText(bytes: Uint8Array, encoding: WorkspaceBlobRef['encoding']): string {
  if (encoding === 'utf16le') {
    if (bytes.length % 2) throw new Error('Invalid UTF-16 length')
    // TextDecoder replaces lone surrogates; preserve every saved code unit for inspection
    let text = ''
    for (let i = 0; i < bytes.length; i += 2) text += String.fromCharCode(bytes[i] | bytes[i + 1] << 8)
    return JSON.stringify(text)
  }
  if (encoding === 'utf8') return JSON.stringify(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join(' ')
}
function Content({ token, role, blobs, filename, version }: { readonly token: ProfileToken; readonly role: ContentRole; readonly blobs: WorkspaceState['blobs']; readonly filename: string; readonly version: string }) {
  const [preview, setPreview] = useState<string>(), [error, setError] = useState('')
  const lifetime = useRef(0)
  useEffect(() => { lifetime.current++; setPreview(undefined); setError(''); return () => { lifetime.current++ } }, [token, role.ref])
  async function inspect(download: boolean) {
    const captured = lifetime.current
    let bytes: Uint8Array | undefined
    try {
      assertActiveProfile(token)
      const source = blobs.find(blob => blobIdentity(blob.ref) === blobIdentity(role.ref))
      if (!source || source.content.byteLength !== role.ref.byteLength || JSON.stringify(source.ref) !== JSON.stringify(role.ref)) throw new Error('Content association changed')
      bytes = await readBlob(source.content, download ? NATIVE_BACKUP_ARCHIVE_LIMITS.maxEntryUncompressedBytes : PREVIEW_BYTES)
      if (await sha256(bytes) !== role.ref.sha256) throw new Error('Content digest changed')
      assertActiveProfile(token)
      if (captured !== lifetime.current) return
      setError('')
      if (download) {
        // A history download never updates the active save's exported revision
        const suffix = role.ref.encoding === 'bytes' ? '' : `.${role.ref.encoding}`
        downloadBytes(bytes, `${version}-${role.label.toLowerCase().replaceAll(' ', '-')}-${filename}${suffix}`)
      } else setPreview(escapedText(bytes, role.ref.encoding))
    } catch {
      try { assertActiveProfile(token) } catch { return }
      if (captured === lifetime.current) setError(download ? 'This saved file could not be downloaded. The local download limit is 128 MiB. Both originals remain saved.' : 'This content could not be previewed. Previews are limited to 64 KiB. Download the saved content to inspect it.')
    } finally { bytes?.fill(0) }
  }
  return <div><p>{role.label}: {role.ref.byteLength} bytes ({role.ref.encoding})</p><button onClick={() => { void inspect(false) }}>Inspect {role.label.toLowerCase()}</button><button onClick={() => { void inspect(true) }}>Download {role.label.toLowerCase()}</button>{preview !== undefined && <><p>{role.ref.encoding === 'bytes' ? 'Hexadecimal bytes' : 'Escaped text; Unicode escapes preserve saved code units'}</p><pre aria-label={`${role.label} content`}>{preview}</pre></>}{error && <p role="alert">{error}</p>}</div>
}
export function ConflictFileVersion({ token, documents, blobs, version }: { readonly token: ProfileToken; readonly documents: readonly WorkspaceDocument[]; readonly blobs: WorkspaceState['blobs']; readonly version: string }) {
  return <>{documents.filter(document => ['editor', 'save', 'asset'].includes(document.kind)).map(document => {
    let filename: string, metadata: string, roles: ContentRole[]
    if (document.kind === 'editor') {
      const file = EditorWorkspaceDocumentSchema.parse(document.value)
      filename = file.filename
      metadata = `Revision ${file.revision}; updated ${file.updatedAt}; draft ${file.unfinished.validation}. ${file.originalByteIdentity === 'text-only' ? 'Source text was retained; original file bytes are unavailable.' : 'Original file bytes are retained.'}`
      roles = [{ label: 'Saved draft', ref: file.unfinished.text }, { label: 'Last applied text', ref: file.lastApplied }, { label: file.originalByteIdentity === 'text-only' ? 'Saved source text' : 'Original file', ref: file.original }]
    } else if (document.kind === 'save') {
      const file = SaveWorkspaceDocumentSchema.parse(document.value)
      filename = file.filename; metadata = `Revision ${file.revision}; updated ${file.updatedAt}; ${file.coverage.status}. ${file.coverage.diagnostics.join(' ')}`
      roles = [{ label: 'Working file', ref: file.working }, { label: 'Original file', ref: file.original }]
    } else {
      const file = WorkspaceAssetSchema.parse(document.value)
      filename = file.relativePath; metadata = `${file.mediaType}; ${file.width} × ${file.height}; source ${file.sourceKey}`
      roles = [{ label: 'Original asset', ref: file.original }]
    }
    return <div key={document.key}><p><strong>{filename}</strong></p><p>{metadata}</p>{roles.map(role => <Content key={role.label} token={token} role={role} blobs={blobs} filename={filename} version={version}/>)}</div>
  })}</>
}
