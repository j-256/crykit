import { useMemo, useRef, useState } from 'react'
import { BUNDLED_MOD_LIBRARY } from '../catalog/mod-library-metadata'
import type { BuildBehavior } from '../domain/build-behavior'
import { buildModRequirements, recordedProjectModNames, selectBuildModRevision, type BuildModRequirement } from '../domain/build-mods'
import { completeModLibrary, type LibraryMod } from '../domain/mod-library'
import { resolveGameRules } from '../domain/game-rules'
import { prepareModComposition } from '../domain/mod-layers'
import { modState, recordedModNames, updateModSelections } from '../domain/mods'
import { CURRENT_CRYSTAL_EDIT_VERSION, supportsCrystalEditVersion } from '../domain/crystal-edit-compatibility'
import type { BuildRevisionContent, CatalogSnapshot } from '../domain/types'
import { Badge, Button, Field, InlineNotice } from './components'
import { useDefinitionLibrary } from './definitions'
import { formatAppError } from './model'
import { ModLayersEditor } from './ModLayersEditor'
import { ModSelections } from './ModSelections'
import { BUNDLED_VERSION_PREFIX, buildModVersions, loadBuildModVersion } from './build-mod-sources'
import './build-mods.css'

export function BuildModsEditor({ content, value, onChange, onBusyChange }: { readonly content: BuildRevisionContent; readonly value: BuildBehavior; readonly onChange: (value: BuildBehavior) => void; readonly onBusyChange: (busy: boolean) => void }) {
  const library = useDefinitionLibrary()
  const setup = library.localData.planningGameSetupRevisionId ? library.localData.gameSetups[library.localData.planningGameSetupRevisionId] : undefined
  const requirements = useMemo(() => buildModRequirements(content, library.localData, library.catalogs, setup), [content, library.localData, library.catalogs, setup])
  const projects = useMemo(() => completeModLibrary(library.catalogs, BUNDLED_MOD_LIBRARY), [library.catalogs])
  const [query, setQuery] = useState('')
  const [showOther, setShowOther] = useState(false)
  const [pending, setPending] = useState<string>()
  const [error, setError] = useState<string>()
  const latest = useRef(value)
  latest.current = value
  const projectRequired = new Set(requirements.flatMap(requirement => requirement.projectId ? [requirement.projectId] : []))
  const visible = projects.filter(project => projectRequired.has(project.id) || value.modComposition?.layers.some(layer => layer.catalogId === project.id) || recordedProjectModNames(project.id, value).some(name => modState(value, name) !== 'unknown'))
  const other = projects.filter(project => !visible.includes(project) && `${project.title} ${project.bundled.flatMap(source => source.catalogNames ?? []).join(' ')}`.toLowerCase().includes(query.trim().toLowerCase()))
  const enable = async (project: LibraryMod, selected: string) => {
    if (pending) return
    setPending(project.id); setError(undefined); onBusyChange(true)
    try {
      const catalog = await loadBuildModVersion(project, selected, library.onLoadBundledMod)
      onChange(selectBuildModRevision(latest.current, catalog, library.catalogs))
    } catch (reason) { setError(formatAppError(reason, 'The mod could not be enabled.')) }
    finally { setPending(undefined); onBusyChange(false) }
  }
  const card = (project: LibraryMod, requirement?: BuildModRequirement) => <BuildModCard key={project.id} busy={Boolean(pending)} catalogs={library.catalogs} onChange={onChange} onEnable={selected => void enable(project, selected)} pending={pending === project.id} project={project} requirement={requirement} value={value}/>
  return <div aria-label="Build mods" className="stack build-mods">
    <p className="field__hint">Choose mods for this Build. Changes save with the checkpoint; other Builds and your Playthrough keep their settings.</p>
    {requirements.length > 0 && <section aria-label="Mods required by this build" className="stack"><h3>Required by this build</h3>{requirements.map(requirement => {
      const project = projects.find(candidate => candidate.id === requirement.projectId)
      return project ? card(project, requirement) : <div className="build-mod-card" data-build-mod={requirement.name} key={requirement.name}><strong>{requirement.name}</strong><p>Required by {requirement.selections.join(', ')}. Its source file is missing. Import its JSON through Mods to calculate its effects.</p></div>
    })}</section>}
    {visible.filter(project => !projectRequired.has(project.id)).map(project => card(project))}
    {error && <InlineNotice title="Mod not enabled" tone="danger">{error} Your build selections remain in this editor.</InlineNotice>}
    <details className="build-mods__other" onToggle={event => setShowOther(event.currentTarget.open)}><summary>Add another mod</summary>{showOther && <div className="stack"><Field label="Search available mods"><input aria-label="Search available mods" onChange={event => setQuery(event.target.value)} type="search" value={query}/></Field>{other.map(project => card(project))}</div>}</details>
    <details className="game-setup-named-mods"><summary>Mods without imported files</summary><div className="stack"><p className="field__hint">You can record a mod by name. Calculating its effects requires a matching source version.</p><ModSelections sourceNames={value.modComposition?.layers.flatMap(layer => BUNDLED_MOD_LIBRARY.find(source => source.id === layer.catalogId)?.catalogNames ?? [])} value={value} onChange={changes => onChange({ ...latest.current, ...changes })}/></div></details>
    <details className="build-mods__advanced"><summary>Mod priority and replacement links</summary><ModLayersEditor catalogLock={value.catalogLock} composition={value.modComposition} onChange={modComposition => onChange({ ...latest.current, modComposition })}/></details>
  </div>
}

function BuildModCard({ project, requirement, value, catalogs, busy, pending, onEnable, onChange }: { readonly project: LibraryMod; readonly requirement?: BuildModRequirement; readonly value: BuildBehavior; readonly catalogs: readonly CatalogSnapshot[]; readonly busy: boolean; readonly pending: boolean; readonly onEnable: (version: string) => void; readonly onChange: (value: BuildBehavior) => void }) {
  const pin = value.modComposition?.layers.find(layer => layer.catalogId === project.id)
  const versions = buildModVersions(project)
  const [draft, setDraft] = useState<string>()
  const selected = draft && versions.some(version => version.id === draft) ? draft : pin?.catalogRevisionId ?? versions[0]?.id ?? ''
  const names = recordedProjectModNames(project.id, value)
  const state = pin ? pin.enabled ? 'enabled' : 'disabled' : requirement?.state ?? (names.length ? modState(value, names[0]!) : 'unknown')
  const source = pin ? catalogs.find(catalog => catalog.id === pin.catalogId && catalog.revisionId === pin.catalogRevisionId) : undefined
  const version = selected.startsWith(BUNDLED_VERSION_PREFIX) ? project.bundled.find(source => `${BUNDLED_VERSION_PREFIX}${source.sourceDigest}` === selected)?.editorVersion : project.revisions.find(revision => revision.catalogRevisionId === selected)?.editorVersion
  const issues = pin?.enabled ? resolveGameRules({ modComposition: { ...value.modComposition!, layers: [pin] } }, catalogs).issues : []
  const name = requirement?.name ?? project.title
  const disable = () => {
    const choices = recordedModNames(value).filter(candidate => names.includes(candidate)).map(candidate => ({ name: candidate, state: 'disabled' as const }))
    const composition = pin ? prepareModComposition(value.modComposition!, catalogs) : undefined
    onChange({ ...value, ...updateModSelections(value, choices), ...(composition ? { modComposition: { ...composition, layers: composition.layers.map(layer => layer.catalogId === project.id ? { ...layer, enabled: false } : layer) } } : {}) })
  }
  return <section aria-label={`Mod ${name}`} className="build-mod-card stack" data-build-mod={name}>
    <div className="split"><strong>{name}</strong><Badge tone={state === 'enabled' && pin ? 'positive' : state === 'disabled' ? 'neutral' : 'warning'}>{state === 'enabled' && !pin ? 'Enabled name; choose a version' : state === 'unknown' ? 'Not enabled for this build' : state}</Badge></div>
    {requirement && <p>Required by {requirement.selections.join(', ')}.</p>}
    <Field hint="This checkpoint keeps the selected source version." label={`Version of ${name}`}><select aria-label={`Version of ${name}`} disabled={busy} onChange={event => setDraft(event.target.value)} value={selected}>{pin && !source && <option value={pin.catalogRevisionId}>Saved version unavailable</option>}{versions.map(version => <option key={version.id} value={version.id}>{version.label}</option>)}</select></Field>
    {supportsCrystalEditVersion(version) && version < CURRENT_CRYSTAL_EDIT_VERSION && <p>This mod uses an older format. CryKit adapts supported settings for calculations without changing the original file.</p>}
    {!supportsCrystalEditVersion(version) && <p>Calculation support for format {version ?? 'unknown'} is unsupported. The source is kept, but totals are unavailable.</p>}
    {issues.length > 0 && <InlineNotice title="Calculation support needs review" tone="warning"><ul>{issues.map(issue => <li key={issue}>{issue}</li>)}</ul></InlineNotice>}
    <div className="cluster"><Button disabled={busy || !selected || Boolean(pin?.enabled && pin.catalogRevisionId === selected)} onClick={() => onEnable(selected)} tone="secondary" type="button">{pending ? 'Loading mod source...' : pin?.enabled ? `Use selected version of ${name}` : `Enable ${name} for this build`}</Button>{state !== 'disabled' && (pin || state === 'enabled') && <Button disabled={busy} onClick={disable} tone="quiet" type="button">Disable {name}</Button>}</div>
  </section>
}
