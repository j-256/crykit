import { modCatalogTitle } from '../domain/mod-layers'
import { useRef, useState } from 'react'
import type { ImportPreview } from '../interchange/types'
import { previewLibrarySource } from '../workspace/mod-repository'
import { useDefinitionLibrary } from './definitions'
import { useWorkspace } from './WorkspaceProvider'
import { useBuildInput } from './build-input-session'
import { Button, IconButton, InlineNotice } from './components'

export function BuildLibraryImport({ onChooseLibrary }: { readonly onChooseLibrary?: () => void }) {
  const input = useBuildInput()
  return input ? <OwnedBuildLibraryImport onChooseLibrary={onChooseLibrary}/> : null
}
function OwnedBuildLibraryImport({ onChooseLibrary }: { readonly onChooseLibrary?: () => void }) {
  const workspace = useWorkspace(), library = useDefinitionLibrary()
  const file = useRef<HTMLInputElement>(null)
  const [preview, setPreview] = useState<ImportPreview>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const pending = workspace.buildInputSession.phase !== 'idle'
  const prepare = async (selected: File) => {
    setBusy(true); setError(undefined)
    try {
      const value = await workspace.repository.previewImport(new Uint8Array(await selected.arrayBuffer()), selected.name)
      await previewLibrarySource(value)
      if (!workspace.isCurrent()) throw new Error('The workspace changed. Select the file again in its original workspace.')
      setPreview(value)
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  const commit = async () => {
    if (!preview || !library.onImportMod) return
    setBusy(true); setError(undefined)
    try { await library.onImportMod(preview) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  return <div className={`stack build-library-import${preview || error ? ' build-library-import--expanded' : ''}`} onChange={event => event.stopPropagation()}>
    <div className="cluster"><IconButton disabled={busy || pending} icon="upload" label="Add files" onClick={() => file.current?.click()}/>{onChooseLibrary && <IconButton disabled={busy || pending} icon="archive" label="Choose from library" onClick={onChooseLibrary}/>}</div>
    <input hidden ref={file} aria-label="Import Build mod JSON" accept=".json,application/json" type="file" onChange={event => { const selected = event.target.files?.[0]; if (selected) void prepare(selected) }}/>
    {preview && <section aria-label="Import Build mod choices"><p>Add {modCatalogTitle(preview.proposed.catalogs[0]!)} to your library. Your Build stays unsaved.</p><Button disabled={busy || pending} onClick={() => void commit()} type="button">{busy ? 'Adding mod...' : 'Add mod JSON'}</Button><Button disabled={busy || pending} onClick={() => setPreview(undefined)} type="button" tone="quiet">Cancel import</Button></section>}
    {error && !pending && <InlineNotice title="Mod import needs attention" tone="warning">{error}</InlineNotice>}
  </div>
}
