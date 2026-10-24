import { DEFAULT_CATALOG } from '../catalog/bundled'
import { saveEditorDefinitionScope, type SaveEditorModSource } from '../domain/save-editor-mods'
import type { SaveEditorSummary } from '../domain/save-editor'
import type { CrystalSave } from '../interchange/crystal-save'
import type { BuildRevisionContent, EntityRef, JsonValue, LocalData } from '../domain/types'

export function saveSelectionContext(localData: LocalData, content: BuildRevisionContent): JsonValue {
  const refs = [content.primaryClass, content.secondaryClass, ...Object.values(content.equipment).map(value => value?.ref), ...content.passives.map(value => value.ref)].filter((ref): ref is EntityRef => !!ref)
  // Pending choices carry exact association evidence, not retaining edges or authority to substitute a newer definition
  return JSON.parse(JSON.stringify(refs.map(ref => {
    let current = ref
    const seen = new Set<string>(), chain: unknown[] = []
    while (current.kind === 'personal') {
      if (seen.has(current.definitionId)) return { ref, chain, unavailable: 'cycle' }
      seen.add(current.definitionId)
      const definition = localData.personalDefinitions[current.definitionId]
      if (!definition) return { ref, chain, unavailable: current.definitionId }
      chain.push(definition)
      if (!definition.baseRef) return { ref, chain, root: current }
      current = definition.baseRef
    }
    return { ref, chain, root: current }
  }))) as JsonValue
}

export function saveDefinitionContext(save: CrystalSave, sources: readonly SaveEditorModSource[], mode: SaveEditorSummary['mode']): JsonValue {
  const scope = saveEditorDefinitionScope(save, DEFAULT_CATALOG, sources, mode)
  // Working bytes have their own strict controller base; context identifies the exact definitions behind persisted input
  return JSON.parse(JSON.stringify({ baseline: { id: DEFAULT_CATALOG.id, revision: DEFAULT_CATALOG.revisionId, checksum: DEFAULT_CATALOG.checksum }, sources: sources.map(source => ({ id: source.id, version: source.version ?? null, checksum: source.checksum, catalogId: source.catalog?.id ?? null, catalogRevision: source.catalog?.revisionId ?? null, catalogChecksum: source.catalog?.checksum ?? null })), mode, bindings: Object.fromEntries(scope.bindings) })) as JsonValue
}
