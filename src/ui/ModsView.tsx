import { guestInspectorFor, usesManagedGuestStorage } from '../workspace/guest-repository'
import { readLibrarySource } from '../workspace/mod-repository'
import { INSPECTOR_REFERENCE_ID } from '../mod-inspector/reference'
import { useWorkspace } from './WorkspaceProvider'
import { bundledModEditableSource } from '../catalog/mod-library'
import { ModLibrary, type SetModReference } from './ModLibrary'
import { ModInspectorView, type SaveModToLibrary } from './ModInspectorView'
import { useCallback, useId, useState } from 'react'
import { Button, ScreenHeader } from './components'
import type { DraftChangeHandler } from './drafts'
import { useNavigation } from './navigation'
import { DefinitionEditor } from './definitions'
import { MOD_WORKSPACE_PAGES, modEditorView, modWorkspaceRoute, type ModWorkspaceView } from './mod-workspace'
import { ModWorkspaceNavigation } from './ModWorkspaceNavigation'
import type { FolderImportPreview, FolderSelection } from '../workspace/folder-import'
import type { LibraryImportReceipt } from '../workspace/mod-repository'

export function ModsView({ onDraftChange, onSaveToLibrary, onConfirmFolder, onSetReference, onChooseMods }: { readonly onDraftChange: DraftChangeHandler; readonly onSaveToLibrary: SaveModToLibrary; readonly onConfirmFolder: (preview: FolderImportPreview, selection: FolderSelection) => Promise<readonly LibraryImportReceipt[]>; readonly onSetReference: SetModReference; readonly onChooseMods: () => void }) {
  const { repository } = useWorkspace()
  const navigation = useNavigation()
  const view = navigation.route.page.page === 'mods' ? navigation.route.page.view : 'library'
  const workspaceView = view === 'library' ? 'library' : modEditorView(navigation.route.query)
  const navigationId = useId()
  const [inspectorDirty, setInspectorDirty] = useState(false)
  const [openingSource, setOpeningSource] = useState<{ readonly filename: string; readonly bytes: Uint8Array; readonly text: string }>()
  const trackDraft = useCallback<DraftChangeHandler>((dirty, actions) => { setInspectorDirty(dirty); onDraftChange(dirty, actions) }, [onDraftChange])
  // The same menu stays mounted across views; dictionary research can retain a pending JSON edit
  const disabledViews: readonly ModWorkspaceView[] = !inspectorDirty ? [] : workspaceView === 'map' ? MOD_WORKSPACE_PAGES.filter(item => item.id !== 'map').map(item => item.id) : ['library', 'map']
  const overlay = navigation.route.overlays[0]
  const creating = overlay?.kind === 'definition-editor' && overlay.mode === 'new'
  const navigate = (next: ModWorkspaceView, draftId?: string) => navigation.navigate(modWorkspaceRoute(next, draftId ? { draft: [draftId] } : navigation.route.query))
  return <div className="stack">
    <ScreenHeader eyebrow="Buildcrafting" title="Mods" description="Browse mod content, author map placements, and choose which mods your Game Setup uses." actions={<Button icon="layers" onClick={onChooseMods}>Choose mods</Button>}/>
    <ModWorkspaceNavigation id={navigationId} view={workspaceView} disabled={disabledViews} onChange={next => navigate(next)}/>
    {view === 'library' ? <section role="tabpanel" id={`${navigationId}-library-panel`} aria-labelledby={`${navigationId}-library-tab`} tabIndex={0}><ModLibrary onSetReference={onSetReference} onOpenEditor={() => navigate('document')} onImport={onSaveToLibrary} onConfirmFolder={onConfirmFolder} onEditBundled={async mod => {
      if (repository.kind === 'account' || await usesManagedGuestStorage(repository)) {
        const source = await bundledModEditableSource(mod)
        setOpeningSource({ ...source, bytes: new TextEncoder().encode(source.text) })
        navigation.navigate(modWorkspaceRoute('document', {}))
        return
      }
      const storage = guestInspectorFor(repository)
      const source = await bundledModEditableSource(mod)
      const draft = await (await storage).import(source.filename, source.text, INSPECTOR_REFERENCE_ID)
      navigate('document', draft.id)
    }} onEdit={async revision => {
      if (repository.kind === 'account' || await usesManagedGuestStorage(repository)) {
        setOpeningSource(await readLibrarySource(repository, revision))
        navigation.navigate(modWorkspaceRoute('document', {}))
        return
      }
      const storage = guestInspectorFor(repository)
      const source = await repository.readModSource(revision)
      const draft = await (await storage).import(source.filename, source.text, INSPECTOR_REFERENCE_ID)
      navigate('document', draft.id)
    }}/></section> : <ModInspectorView embedded navigationId={navigationId} view={modEditorView(navigation.route.query)} onViewChange={next => navigate(next)} initialDraftId={navigation.route.query.draft?.[0]} onDraftChange={trackDraft} onSaveToLibrary={onSaveToLibrary} openSource={openingSource} onOpenSourceFinished={() => setOpeningSource(undefined)}/>}
    {creating && <DefinitionEditor open allowedKinds={[]} initialSourceMod={navigation.route.query.mod?.[0]} initialSourceModProjectId={navigation.route.query['mod-project']?.[0]} routeIndex={0} onClose={() => navigation.close()} onSaved={ref => navigation.navigate({ page: { page: 'reference', view: 'detail', ref }, overlays: [], query: {} })}/>}
  </div>
}
