import { useEffect, useMemo, useState } from 'react'
import { BUNDLED_MOD_LIBRARY, bundledModEditableSource } from '../catalog/mod-library'
import { bundledModDefinitionCount, completeModLibrary } from '../domain/mod-library'
import { modIsInReference } from '../domain/reference-library'
import type { CatalogSnapshot } from '../domain/types'
import { previewCrystalEdit } from '../interchange/crystal-edit'
import { Button, InlineNotice } from './components'
import { DefinitionProvider, useDefinitionLibrary } from './definitions'
import { buildModLibraryCards } from './mod-library-data'
import type { SetModReference } from './ModLibrary'
import { ReferenceView, type ReferenceViewProps } from './ReferenceView'
import type { SaveModToLibrary } from './ModInspectorView'
import { useNavigation } from './navigation'

const EMPTY_CATALOGS: readonly CatalogSnapshot[] = []

export default function ModCatalogReference({ scopeId, onAddReference, onSetReference, onRouteCatalogsChange, ...props }: ReferenceViewProps & { readonly scopeId: string; readonly onAddReference: SaveModToLibrary; readonly onSetReference: SetModReference; readonly onRouteCatalogsChange: (catalogs: readonly CatalogSnapshot[]) => void }) {
  const navigation = useNavigation()
  const library = useDefinitionLibrary()
  const card = useMemo(() => buildModLibraryCards(library.catalogs, library.options, props.localData).find(card => card.id === scopeId), [library.catalogs, library.options, props.localData, scopeId])
  const inReference = Boolean(card && modIsInReference(props.localData, card))
  const project = useMemo(() => completeModLibrary(library.catalogs, BUNDLED_MOD_LIBRARY).find(mod => mod.id === scopeId), [library.catalogs, scopeId])
  const page = navigation.route.page
  const requestedRef = page.page === 'reference' && page.view === 'detail' && page.ref.kind === 'catalog' && page.ref.catalogId === project?.id ? page.ref : undefined
  const saved = requestedRef ? project?.revisions.find(revision => revision.catalogRevisionId === requestedRef.catalogRevisionId)?.catalog : project?.revisions[0]?.catalog
  const bundled = requestedRef ? project?.bundled.find(source => requestedRef.catalogRevisionId.startsWith(`${source.sourceDigest}:`)) : project?.bundled[0]
  const [loaded, setLoaded] = useState<CatalogSnapshot>()
  const [error, setError] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  const [adding, setAdding] = useState(false)
  useEffect(() => {
    if (saved || !bundled) return
    let active = true
    const load = async () => {
      try {
        const source = await bundledModEditableSource(bundled)
        const preview = await previewCrystalEdit(new TextEncoder().encode(source.text), source.filename)
        const catalog = preview.proposed.catalogs[0]
        if (!catalog || catalog.id !== bundled.id) throw new Error('The bundled catalog has a different mod identity.')
        if (active) { setLoaded(catalog); setError(undefined) }
      } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : 'The mod catalog could not be opened.') }
    }
    void load()
    return () => { active = false }
  }, [saved, bundled, attempt])
  const catalog = saved ?? loaded
  const catalogs = useMemo(() => catalog ? [catalog] : EMPTY_CATALOGS, [catalog])
  const associations = useMemo(() => catalog ? [...library.catalogs.filter(source => source.id !== catalog.id || source.revisionId !== catalog.revisionId), catalog] : library.catalogs, [library.catalogs, catalog])
  useEffect(() => {
    onRouteCatalogsChange(catalogs)
    return () => { onRouteCatalogsChange(EMPTY_CATALOGS) }
  }, [catalogs, onRouteCatalogsChange])
  const returnToReference = () => navigation.navigate({ page: { page: 'reference', view: 'list' }, overlays: [], query: {} })
  const toggleReference = async () => {
    if (!card || adding) return
    setAdding(true); setError(undefined)
    try {
      if (inReference || card.entryCount > 0) await onSetReference(scopeId, !inReference)
      else if (bundled && !saved) {
        const source = await bundledModEditableSource(bundled)
        await onAddReference(source.text, source.filename, bundled.id, true)
      }
      returnToReference()
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Reference membership could not be changed.') }
    finally { setAdding(false) }
  }
  const action = card ? <Button aria-pressed={inReference} disabled={adding || (!card.entryCount && (!bundled || !bundledModDefinitionCount(bundled)))} onClick={() => void toggleReference()} icon={inReference ? 'close' : 'plus'}>{adding ? 'Updating Reference...' : inReference ? 'Remove from Reference' : 'Add to Reference'}</Button> : undefined
  const failure = error && <InlineNotice title="Reference not changed" tone="danger">{error}</InlineNotice>
  if (!project || requestedRef && !saved && !bundled) return <>{failure}<ReferenceView {...props} temporary temporaryAction={action}/></>
  if (!catalog) return <div className="stack"><h1>{project.title}</h1>{error ? <InlineNotice title="Mod catalog unavailable" tone="danger"><p>{error}</p><Button onClick={() => { setError(undefined); setAttempt(value => value + 1) }}>Retry</Button></InlineNotice> : <p role="status">Loading this mod's catalog...</p>}<Button onClick={returnToReference} tone="secondary">Return to Reference</Button></div>
  return <DefinitionProvider catalogs={catalogs} localData={props.localData} onSaveDefinition={async () => { throw new Error('Definitions cannot be edited in a mod preview.') }}>
    {failure}
    <ReferenceView {...props} catalogs={catalogs} associationCatalogs={associations} temporary temporaryAction={action}/>
  </DefinitionProvider>
}
