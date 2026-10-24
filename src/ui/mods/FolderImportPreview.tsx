import { useState } from 'react'
import type { FolderImportPreview as FolderPreview, FolderSelection } from '../../workspace/folder-import'
import { Button } from '../components'

const formatSize = (bytes: number) => `${(bytes / 1024).toFixed(1)} KiB`
const candidateKey = (sourceId: string, relativePath: string) => JSON.stringify([sourceId, relativePath])

export function FolderImportPreview({ preview, busy, onConfirm, onCancel }: { readonly preview: FolderPreview; readonly busy: boolean; readonly onConfirm: (selection: FolderSelection) => void; readonly onCancel: () => void }) {
  const [selected, setSelected] = useState('')
  const [inReference, setInReference] = useState(false)
  const [futureDefault, setFutureDefault] = useState(false)
  const [artwork, setArtwork] = useState<readonly string[]>([])
  const [associations, setAssociations] = useState<Readonly<Record<string, string>>>({})
  const project = preview.projects.find(candidate => candidateKey(candidate.sourceId, candidate.relativePath) === selected)
  const hasUnassociatedArt = artwork.some(path => !associations[path])
  const hasWrongAssociation = artwork.some(path => associations[path] && associations[path] !== selected)
  const confirm = () => {
    if (!project || hasUnassociatedArt || hasWrongAssociation) return
    onConfirm({ projects: [{ projectId: project.projectId, sourceId: project.sourceId, relativePath: project.relativePath, choices: { inReference, futureDefault } }], assets: artwork.map(relativePath => ({ relativePath, projectId: project.projectId, sourceId: project.sourceId, projectRelativePath: project.relativePath })) })
  }
  return <section aria-label="Folder import preview" className="panel"><div className="panel__body stack">
    <h3>Review selected mod files</h3>
    <p>{preview.projects.length} Crystal Edit {preview.projects.length === 1 ? 'revision' : 'revisions'} found. Selected files total {formatSize(preview.totalBytes)}. Only a revision you choose will be saved.</p>
    {preview.projects.length ? <fieldset className="stack"><legend>Choose one project revision</legend>{preview.projects.map(candidate => <label className="check-row" key={candidateKey(candidate.sourceId, candidate.relativePath)}><input type="radio" name="folder-project-revision" checked={selected === candidateKey(candidate.sourceId, candidate.relativePath)} disabled={busy} onChange={() => { setSelected(candidateKey(candidate.sourceId, candidate.relativePath)); setInReference(false); setFutureDefault(false) }}/><span><strong>{candidate.title}</strong> · Project {candidate.projectId} · Version {candidate.declaredVersion ?? 'unspecified'} · {candidate.relativePath} · {formatSize(candidate.byteLength)}</span></label>)}</fieldset> : <p>No supported Crystal Edit JSON was found.</p>}
    {project && <div className="stack"><p>The source joins your library. Existing Builds and Teams keep their saved versions. Enablement in the current Game Setup is a separate choice.</p><label className="check-row"><input type="checkbox" checked={inReference} disabled={busy} onChange={event => setInReference(event.target.checked)}/><span>Add this mod to Reference</span></label><label className="check-row"><input type="checkbox" checked={futureDefault} disabled={busy} onChange={event => setFutureDefault(event.target.checked)}/><span>Enable this version for new Game Setups</span></label></div>}
    {preview.uploadCandidates.length > 0 && <fieldset className="stack"><legend>Possible artwork (optional)</legend><p>Artwork is unchecked. Selected images must match a texture in the chosen revision. If an image fails, deselect it to save the JSON.</p>{preview.uploadCandidates.map(asset => <div className="stack" key={asset.relativePath}><label className="check-row"><input type="checkbox" checked={artwork.includes(asset.relativePath)} disabled={busy} onChange={event => setArtwork(previous => event.target.checked ? [...previous, asset.relativePath] : previous.filter(path => path !== asset.relativePath))}/><span>{asset.relativePath} · {asset.width} × {asset.height} · {formatSize(asset.byteLength)}</span></label>{artwork.includes(asset.relativePath) && <label>Associate {asset.relativePath} with <select aria-label={`Associate ${asset.relativePath} with project revision`} value={associations[asset.relativePath] ?? ''} disabled={busy} onChange={event => setAssociations(previous => ({ ...previous, [asset.relativePath]: event.target.value }))}><option value="">Choose a revision</option>{preview.projects.map(candidate => <option key={candidateKey(candidate.sourceId, candidate.relativePath)} value={candidateKey(candidate.sourceId, candidate.relativePath)}>{candidate.projectId} · Version {candidate.declaredVersion ?? 'unspecified'} · {candidate.relativePath}</option>)}</select></label>}</div>)}</fieldset>}
    {hasUnassociatedArt && <p role="status">Associate each selected image with an exact project revision.</p>}
    {hasWrongAssociation && <p role="status">Selected artwork belongs to another revision. Choose the selected revision or deselect it.</p>}
    {preview.excludedFiles.length > 0 && <details><summary>Excluded files ({preview.excludedFiles.length})</summary><ul>{preview.excludedFiles.map(file => <li key={file.relativePath}>{file.relativePath}: {file.reason}</li>)}</ul></details>}
    <div className="cluster"><Button type="button" disabled={!project || busy || hasUnassociatedArt || hasWrongAssociation} onClick={confirm}>Save selected JSON{artwork.length ? ' and artwork' : ''}</Button><Button type="button" disabled={busy} tone="quiet" onClick={onCancel}>Cancel folder import</Button></div>
  </div></section>
}
