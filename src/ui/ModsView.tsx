import { getInspectorStorage } from '../mod-inspector/storage'
import { INSPECTOR_REFERENCE_ID } from '../mod-inspector/reference'
import { readModSource } from '../persistence/mod-library'
import { bundledModEditableSource } from '../catalog/mod-library'
import { ModLibrary, type SetModReference } from './ModLibrary'
import { ModInspectorView, type SaveModToLibrary } from './ModInspectorView'
import { ScreenHeader, Segmented } from './components'
import type { DraftChangeHandler } from './drafts'
import { useNavigation } from './navigation'
import { DefinitionEditor } from './definitions'

export function ModsView({ onDraftChange, onSaveToLibrary, onSetReference }: { readonly onDraftChange: DraftChangeHandler; readonly onSaveToLibrary: SaveModToLibrary; readonly onSetReference: SetModReference }) {
  const navigation = useNavigation()
  const view = navigation.route.page.page === 'mods' ? navigation.route.page.view : 'library'
  const overlay = navigation.route.overlays[0]
  const creating = overlay?.kind === 'definition-editor' && overlay.mode === 'new'
  const navigate = (next: 'library' | 'editor', draftId?: string) => navigation.navigate({ page: { page: 'mods', view: next }, overlays: [], query: draftId ? { draft: [draftId] } : {} })
  return <div className="stack">
    <ScreenHeader eyebrow="Buildcrafting" title="Mods" description="Manage mods and their catalog entries, including mods without a JSON file."/>
    <Segmented label="Mods workspace" value={view} options={[{ value: 'library', label: 'Mod library' }, { value: 'editor', label: 'Editor workspace' }]} onChange={next => navigate(next)}/>
    {view === 'library' ? <ModLibrary onSetReference={onSetReference} onOpenEditor={() => navigate('editor')} onImport={onSaveToLibrary} onEditBundled={async mod => {
      const source = await bundledModEditableSource(mod)
      const draft = await getInspectorStorage().import(source.filename, source.text, INSPECTOR_REFERENCE_ID)
      navigate('editor', draft.id)
    }} onEdit={async revision => {
      const source = await readModSource(revision)
      const draft = await getInspectorStorage().import(source.filename, source.text, INSPECTOR_REFERENCE_ID)
      navigate('editor', draft.id)
    }}/> : <ModInspectorView embedded initialDraftId={navigation.route.query.draft?.[0]} onDraftChange={onDraftChange} onSaveToLibrary={onSaveToLibrary}/>}
    {creating && <DefinitionEditor open allowedKinds={[]} initialSourceMod={navigation.route.query.mod?.[0]} initialSourceModProjectId={navigation.route.query['mod-project']?.[0]} routeIndex={0} onClose={() => navigation.close()} onSaved={ref => navigation.navigate({ page: { page: 'reference', view: 'detail', ref }, overlays: [], query: {} })}/>}
  </div>
}
