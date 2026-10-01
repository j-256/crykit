import { useState } from 'react'
import { modLibrary, type ModRevision } from '../domain/mod-library'
import { IMPORTED_RULES_VERSION, SUPPORTED_EDITOR_VERSION } from '../domain/game-rules'
import { Button, InlineNotice } from './components'
import { useDefinitionLibrary } from './definitions'
import { useOptionalCorrections } from './corrections-context'
import { useNavigation } from './navigation'

export function ModLibrary({ onOpenEditor, onEdit }: { readonly onOpenEditor: () => void; readonly onEdit: (revision: ModRevision) => Promise<void> }) {
  const library = useDefinitionLibrary()
  const corrections = useOptionalCorrections()
  const mods = modLibrary(corrections?.baseline ?? library.catalogs)
  const navigation = useNavigation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const edit = async (revision: ModRevision) => {
    setBusy(true); setError(undefined)
    try { await onEdit(revision) } catch (reason) { setError(reason instanceof Error ? reason.message : 'The mod revision could not be opened.') }
    finally { setBusy(false) }
  }
  const revisionRow = (revision: ModRevision) => <div className="split" key={revision.catalogRevisionId}>
    <div><strong>{revision.declaredVersion ? `Version ${revision.declaredVersion}` : 'Version unspecified'}</strong><p>{Object.keys(revision.catalog.entities).length} {Object.keys(revision.catalog.entities).length === 1 ? 'definition' : 'definitions'} · {revision.rules?.version === IMPORTED_RULES_VERSION && revision.editorVersion === SUPPORTED_EDITOR_VERSION ? 'Calculation settings inspected' : 'Calculation coverage unavailable'}</p><small>Source {revision.sourceDigest.replace('sha256:', '').slice(0, 12)} · Editor format {revision.editorVersion ?? 'unknown'}</small></div>
    <Button disabled={busy} onClick={() => void edit(revision)} tone="secondary">Edit a copy</Button>
  </div>
  return <div className="stack">
    <div className="split"><div><h2>Saved mods</h2><p className="settings-section__intro">Game Setups choose which mod versions to enable and their order.</p></div><div className="cluster"><Button disabled={busy} onClick={onOpenEditor} icon="plus">Open mod editor</Button><Button disabled={busy} onClick={() => navigation.navigate({ page: { page: 'settings', section: 'game-setup' }, overlays: [], query: {} })} tone="secondary">Game Setups</Button></div></div>
    <p className="field__hint">Open a JSON file in the editor, then choose Save to CryKit. Each saved version keeps its source; builds keep the versions you selected.</p>
    {error && <InlineNotice title="Mod not opened" tone="danger">{error}</InlineNotice>}
    {mods.length === 0 && <InlineNotice title="No saved mods">Add a Crystal Edit mod to use its definitions and supported settings in planning.</InlineNotice>}
    {mods.map(mod => <section aria-label={mod.title} className="panel" key={mod.id}><div className="panel__body stack"><h3>{mod.title}</h3>{revisionRow(mod.revisions[0]!)}{mod.revisions.length > 1 && <details><summary>Earlier versions ({mod.revisions.length - 1})</summary><div className="stack">{mod.revisions.slice(1).map(revisionRow)}</div></details>}</div></section>)}
  </div>
}
