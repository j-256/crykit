import type { catalogSource } from '../domain/catalog-source'
import type { CatalogEntity, EntityRef, PersonalDefinition } from '../domain/types'
import { DefinitionClaimsPanel, DefinitionSourcesPanel } from './DefinitionDetailSections'
import { FieldIconSources, hasExternalFieldIcons } from './GameIcon'
import { NativeClassSourceDetails } from './NativeDefinitionDetails'
import { visibleDefinitionFacts } from './source-display'
import { CatalogArtworkSource, hasExternalCatalogArtwork } from './WikiSprite'

export function PersonalDefinitionSources({ definition, source, nativeEntity, onOpenDefinition }: { definition: CatalogEntity | PersonalDefinition; source?: ReturnType<typeof catalogSource>; nativeEntity?: CatalogEntity; onOpenDefinition: (ref: EntityRef) => void }) {
  const uncertain = visibleDefinitionFacts(definition).some(([, value]) => value.state === 'unknown' || value.state === 'conflicting')
  const externalContent = Boolean(source && (hasExternalCatalogArtwork(source.catalog.id, source.entity) || source.claims.length > 0)) || hasExternalFieldIcons(definition.fields)
  // Personal edits keep inherited native evidence without implying an original for a new unsourced definition
  return <DefinitionSourcesPanel includeNativeSources label={`Sources for ${definition.name}`} sources={definition.sources} uncertain={uncertain} hasExternalContent={externalContent}>
    {source && <p>Sources refer to the original definition.</p>}
    {uncertain && source && nativeEntity && <NativeClassSourceDetails catalog={source.catalog} entity={nativeEntity} onOpenDefinition={onOpenDefinition}/>}
    {source && <CatalogArtworkSource catalogId={source.catalog.id} entity={source.entity}/>}
    <FieldIconSources fields={definition.fields}/>
    {(source?.claims.length ?? 0) > 0 && <DefinitionClaimsPanel claims={source!.claims}/>}
  </DefinitionSourcesPanel>
}
