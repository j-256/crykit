import { getInspectorStorage } from '../mod-inspector/storage'
import { INSPECTOR_REFERENCE_ID } from '../mod-inspector/reference'
import { readModSource } from '../persistence/mod-library'
import { ModLibrary } from './ModLibrary'
import { ModInspectorView, type SaveModToLibrary } from './ModInspectorView'
import { ScreenHeader, Segmented } from './components'
import type { DraftChangeHandler } from './drafts'
import { useNavigation } from './navigation'

export function ModsView({ onDraftChange, onSaveToLibrary }: { readonly onDraftChange: DraftChangeHandler; readonly onSaveToLibrary: SaveModToLibrary }) {
  const navigation = useNavigation()
  const view = navigation.route.page.page === 'mods' ? navigation.route.page.view : 'library'
  const navigate = (next: 'library' | 'editor', draftId?: string) => navigation.navigate({ page: { page: 'mods', view: next }, overlays: [], query: draftId ? { draft: [draftId] } : {} })
  return <div className="stack">
    <ScreenHeader eyebrow="Buildcrafting" title="Mods" description="Save mod versions for planning, or inspect and edit their JSON in the workspace."/>
    <Segmented label="Mods workspace" value={view} options={[{ value: 'library', label: 'Mod library' }, { value: 'editor', label: 'Editor workspace' }]} onChange={next => navigate(next)}/>
    {view === 'library' ? <ModLibrary onOpenEditor={() => navigate('editor')} onEdit={async revision => {
      const source = await readModSource(revision)
      const draft = await getInspectorStorage().import(source.filename, source.text, INSPECTOR_REFERENCE_ID)
      navigate('editor', draft.id)
    }}/> : <ModInspectorView embedded initialDraftId={navigation.route.query.draft?.[0]} onDraftChange={onDraftChange} onSaveToLibrary={onSaveToLibrary}/>}
  </div>
}
