import { entityDefinitionKey } from '../domain/core'
import { checkpointContentDigest } from '../domain/checkpoint-identity'
import { retainedSelectionRefs } from '../domain/retained-selections'
import { modSourceReceipts, withBuildReferenceNames } from '../domain/build-reference-names'
import { composeModCatalog, expandModCatalogs } from '../domain/mod-layers'
import { fulfillSource, sourcePayloadValid } from '../domain/source-fulfillment'
import type { BuildRevisionContent, CatalogSnapshot, GameSetupRevision } from '../domain/types'

// Recovery restores exact bodies without changing interpretation, links, or a saved checkpoint's identity
export function prepareLocalBuildModRecovery(content: BuildRevisionContent, setup: GameSetupRevision, catalogs: readonly CatalogSnapshot[]): { draft?: { content: BuildRevisionContent; setup: GameSetupRevision }; changedInterpretation?: boolean; missingSources: readonly string[]; error?: string } {
  const missingSources: string[] = []
  try {
    const composition = setup.modComposition
    const sources = composition ? [composition.baseline, ...composition.layers].flatMap(pin => {
      const source = fulfillSource(pin, catalogs)?.catalog
      const receipt = setup.modSourceReceipts?.find(value => value.catalogId === pin.catalogId && value.catalogRevisionId === pin.catalogRevisionId)
      if (!source || !sourcePayloadValid(source) || receipt && receipt.checksum !== source.checksum) { missingSources.push(receipt?.title ?? `${pin.catalogId} @ ${pin.catalogRevisionId}`); return [] }
      return [source]
    }) : catalogs
    if (missingSources.length) return { missingSources }
    const effective = composition ? composeModCatalog(setup, sources) : undefined
    const complete = effective ? expandModCatalogs([...sources, effective]) : sources
    const refreshed = withBuildReferenceNames(content, complete)
    const retained = retainedSelectionRefs(content)
    for (const saved of content.referenceNames ?? []) {
      if (retained.has(entityDefinitionKey(saved.ref))) continue
      const next = refreshed.referenceNames?.find(value => entityDefinitionKey(value.ref) === entityDefinitionKey(saved.ref))
      if (next && (saved.projectId && saved.projectId !== next.projectId || saved.modelKey && saved.modelKey !== next.modelKey || saved.origins && checkpointContentDigest(saved.origins) !== checkpointContentDigest(next.origins))) throw new Error(`The exact sources cannot resolve ${saved.name} with its saved contributor receipt`)
    }
    return { draft: { content: refreshed, setup: { ...setup, ...(composition ? { modSourceReceipts: modSourceReceipts(setup, sources) } : {}) } }, changedInterpretation: false, missingSources }
  } catch (reason) {
    return { missingSources, error: reason instanceof Error ? reason.message : 'Exact source recovery failed. The original checkpoint is preserved.' }
  }
}
