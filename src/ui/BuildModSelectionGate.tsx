import { createContext, useContext, useMemo, useRef, useState, type PropsWithChildren } from 'react'
import { BUNDLED_MOD_LIBRARY } from '../catalog/mod-library-metadata'
import type { BuildBehavior } from '../domain/build-behavior'
import { buildModReferences, buildModRequirements, selectBuildModRevision, type BuildModRequirement } from '../domain/build-mods'
import { bundledModIdentity } from '../domain/bundled-mods'
import { completeModLibrary } from '../domain/mod-library'
import { updateModSelections } from '../domain/mods'
import type { BuildRevisionContent, EntityRef } from '../domain/types'
import { Button, Field, InlineNotice } from './components'
import { findDefinitionOption, useDefinitionLibrary, type DefinitionOption } from './definitions'
import { formatAppError } from './model'
import { Sheet } from './Sheet'
import { BUNDLED_VERSION_PREFIX, buildModVersions, loadBuildModVersion } from './build-mod-sources'

interface ModSelection {
  readonly option: DefinitionOption
  readonly accept: () => void
  readonly cancel: () => void
  readonly restoreFocus: () => void
  readonly enableOnly?: boolean
}
interface PendingSelection extends ModSelection { readonly requirement: BuildModRequirement; readonly version: string }
interface BuildModSelection {
  readonly select: (selection: ModSelection) => void
  readonly enable: (requirement: BuildModRequirement) => void
}
const BuildModSelectionContext = createContext<BuildModSelection | undefined>(undefined)
export const useBuildModSelection = () => useContext(BuildModSelectionContext)

export function BuildModSelectionGate({ content, value, onChange, onBusyChange, children }: PropsWithChildren<{ readonly content: BuildRevisionContent; readonly value: BuildBehavior; readonly onChange: (value: BuildBehavior) => void; readonly onBusyChange: (busy: boolean) => void }>) {
  const library = useDefinitionLibrary()
  const setup = library.localData.planningGameSetupRevisionId ? library.localData.gameSetups[library.localData.planningGameSetupRevisionId] : undefined
  const projects = useMemo(() => completeModLibrary(library.catalogs, BUNDLED_MOD_LIBRARY), [library.catalogs])
  const [pending, setPending] = useState<PendingSelection>()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string>()
  const submittingRef = useRef(false)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const pendingRef = useRef<PendingSelection | undefined>(undefined)
  const latest = useRef({ value, library })
  latest.current = { value, library }
  const requirementFor = (ref: EntityRef) => buildModRequirements({ primaryClass: ref, secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [] }, library.localData, library.catalogs, setup)[0]
  const select = (selection: ModSelection) => {
    if (pendingRef.current) return
    const requirement = requirementFor(selection.option.ref)
    if (!requirement || requirement.state === 'enabled' && (!requirement.projectId || value.modComposition?.layers.some(layer => layer.enabled && layer.catalogId === requirement.projectId))) { selection.accept(); return }
    const project = projects.find(project => project.id === requirement.projectId)
    const versions = project ? buildModVersions(project) : []
    const ref = selection.option.ref
    const bundled = bundledModIdentity(selection.option.record)
    const source = project?.bundled.find(source => source.key === bundled?.key && source.declaredVersion === bundled?.version || ref.kind === 'catalog' && ref.catalogRevisionId.startsWith(source.sourceDigest + ':'))
    const saved = source && project?.revisions.find(revision => revision.sourceDigest === source.sourceDigest)
    const version = ref.kind === 'catalog' && ref.catalogId === project?.id && project.revisions.some(revision => revision.catalogRevisionId === ref.catalogRevisionId) ? ref.catalogRevisionId : saved?.catalogRevisionId ?? (source ? `${BUNDLED_VERSION_PREFIX}${source.sourceDigest}` : value.modComposition?.layers.find(layer => layer.catalogId === project?.id)?.catalogRevisionId) ?? versions[0]?.id ?? ''
    const next = { ...selection, requirement, version }
    pendingRef.current = next; setPending(next); setError(undefined); onBusyChange(true)
  }
  const enable = (requirement: BuildModRequirement) => {
    const ref = buildModReferences(content).find(ref => requirement.projectId ? requirementFor(ref)?.projectId === requirement.projectId : requirementFor(ref)?.name === requirement.name)
    const option = ref && findDefinitionOption(library.planningOptions, ref)
    if (option) select({ option, accept: () => undefined, cancel: () => undefined, restoreFocus: () => undefined, enableOnly: true })
  }
  const close = (accepted = false) => {
    const selection = pendingRef.current
    if (!selection) return
    pendingRef.current = undefined; submittingRef.current = false; setPending(undefined); setSubmitting(false); onBusyChange(false)
    if (!accepted) selection.cancel()
    window.requestAnimationFrame(selection.restoreFocus)
  }
  const confirm = async () => {
    const selection = pendingRef.current
    if (!selection || submittingRef.current) return
    submittingRef.current = true; setSubmitting(true); setError(undefined)
    try {
      const project = projects.find(project => project.id === selection.requirement.projectId)
      const catalog = project && selection.version ? await loadBuildModVersion(project, selection.version, latest.current.library.onLoadBundledMod) : undefined
      onChange(catalog ? selectBuildModRevision(latest.current.value, catalog, latest.current.library.catalogs) : { ...latest.current.value, ...updateModSelections(latest.current.value, [{ name: selection.requirement.name, state: 'enabled' }]) })
      selection.accept(); close(true)
    } catch (reason) { submittingRef.current = false; setError(formatAppError(reason, 'The mod could not be enabled.')); setSubmitting(false) }
  }
  const project = projects.find(project => project.id === pending?.requirement.projectId)
  const versions = project ? buildModVersions(project) : []
  const version = versions.find(version => version.id === pending?.version)
  return <BuildModSelectionContext.Provider value={{ select, enable }}>{children}
    <Sheet initialFocusRef={confirmRef} open={Boolean(pending)} title={`Enable ${pending?.requirement.name ?? 'required mod'}?`} onClose={() => close()} onRequestClose={() => !submittingRef.current} footer={<div className="form-actions"><Button disabled={submitting} onClick={() => close()} tone="quiet" type="button">Cancel</Button><Button ref={confirmRef} disabled={submitting || Boolean(versions.length && !version)} onClick={() => void confirm()} type="button">{submitting ? 'Enabling...' : pending?.enableOnly ? `Enable ${pending.requirement.name}` : `Enable and select ${pending?.option.name ?? ''}`}</Button></div>}>
      {pending && <div className="stack"><p><strong>{pending.option.name}</strong> requires <strong>{pending.requirement.name}</strong>. Enable the mod for this build{pending.enableOnly ? '?' : ' and use this selection?'}</p><p className="field__hint">Save a checkpoint to keep this mod choice. Other Builds and your Playthrough keep their settings.</p>
        {version ? <><p>Version {version.version ?? 'unspecified'}</p><details><summary>Version details</summary><Field label="Mod version"><select aria-label="Mod version" disabled={submitting} value={pending.version} onChange={event => { const next = { ...pending, version: event.target.value }; pendingRef.current = next; setPending(next) }}>{versions.map(version => <option key={version.id} value={version.id}>{version.label}</option>)}</select></Field></details></> : <p>The source file is unavailable. You can enable this mod, but its stat effects will stay unknown.</p>}
        {error && <InlineNotice title="Mod could not be enabled" tone="danger">{error} Your selection has not changed. Try again or cancel.</InlineNotice>}
      </div>}
    </Sheet>
  </BuildModSelectionContext.Provider>
}
