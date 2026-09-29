import { definitionModAvailability } from '../catalog/mods'
import { historicalCatalogKeys } from '../domain/corrections'
import { useEffect, useMemo, useRef, useState } from 'react'
import { entityDefinitionKey, preferredDefinitionRef, resolveDefinition, sameLogicalEntity, skillTreeShape, squareKey, type ReviewedSkillTree } from '../domain'
import type { CatalogEntityKind, CatalogSnapshot, CharacterId, EntityRef, LearnedNodeKind, Profile, SkillSquareState, SkillTreeMapping } from '../domain/types'
import { previewSkillScreenshots, releaseScreenshotPreviews, type ScreenshotPreview } from '../interchange/skill-screenshots'
import { matchScreenshotClassName, type ScreenshotClassNameMatch } from '../interchange/skill-class-names'
import { GRID_STEP, GRID_X, GRID_Y, SQUARE_SIZE } from '../interchange/skill-grid'
import { Button, Field, InlineNotice } from './components'
import { Sheet } from './Sheet'
import { routeWithoutOverlays, useNavigation, useNavigationBlocker } from './navigation'
import { CONFIRMED_SKILL_MAP_SETS, skillMapSetForRuleset, suggestSkillTreeMap } from '../catalog/skill-maps'

interface Choice { readonly ref: EntityRef; readonly name: string; readonly kind: CatalogEntityKind; readonly className?: string; readonly requiredMod?: string }
interface Draft { readonly preview: ScreenshotPreview; readonly characterId?: CharacterId; readonly classRef?: EntityRef; readonly classMatch?: ScreenshotClassNameMatch<Choice>; readonly mappings: readonly SkillTreeMapping[]; readonly reviewed: boolean; readonly included: boolean }
const SQUARE_LABELS: Readonly<Record<SkillSquareState, string>> = { learned: 'Learned', available: 'Available, not learned', locked: 'Locked, not learned', unknown: 'Unknown' }

function choices(profile: Profile, catalogs: readonly CatalogSnapshot[]): readonly Choice[] {
  const ruleset = profile.activeRulesetRevisionId ? profile.rulesets[profile.activeRulesetRevisionId] : undefined
  const historical = historicalCatalogKeys(catalogs)
  const availableCatalogs = catalogs.filter(catalog => {
    const pinned = ruleset?.catalogLock[catalog.id]
    return pinned ? catalog.revisionId === pinned : !historical.has(JSON.stringify([catalog.id, catalog.revisionId]))
  })
  const refs: EntityRef[] = [
    ...availableCatalogs.flatMap(catalog => Object.values(catalog.entities).map(entity => ({ kind: 'catalog' as const, catalogId: catalog.id, catalogRevisionId: catalog.revisionId, entityId: entity.id }))),
    ...Object.values(profile.personalDefinitions).map(definition => ({ kind: 'personal' as const, definitionId: definition.id })),
  ]
  const result = new Map<string, Choice>()
  for (const initial of refs) {
    const ref = preferredDefinitionRef(profile, initial)
    const entity = resolveDefinition(profile, catalogs, ref)
    if (!entity || !['class', 'ability', 'passive', 'innate', 'monsterMagic'].includes(entity.kind)) continue
    const modAvailability = definitionModAvailability(profile, ref, ruleset)
    if (modAvailability.state === 'disabled') continue
    const field = entity.fields.Class
    result.set(entityDefinitionKey(ref), { ref, name: entity.name, kind: entity.kind, ...(field?.state === 'known' && typeof field.value === 'string' ? { className: field.value } : {}), ...(modAvailability.requiredMod ? { requiredMod: modAvailability.requiredMod } : {}) })
  }
  return [...result.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function uniqueName<T extends { readonly name: string }>(items: readonly T[], name?: string): T | undefined {
  const matches = items.filter(item => item.name.toLocaleLowerCase() === name?.toLocaleLowerCase())
  return matches.length === 1 ? matches[0] : undefined
}

function choiceLabel(choice: Choice): string {
  return `${choice.name}${choice.requiredMod ? ` (${choice.requiredMod} mod)` : ''}`
}

export function SkillScreenshotImport({ profile, catalogs, onImport }: { readonly profile: Profile; readonly catalogs: readonly CatalogSnapshot[]; readonly onImport: (captures: readonly ReviewedSkillTree[], expectedRevision: number) => Promise<void> }) {
  const navigation = useNavigation()
  const revision = useRef(profile.revision)
  const profileId = useRef(profile.id)
  const ruleset = useRef(profile.activeRulesetRevisionId)
  const [mapSetId, setMapSetId] = useState(() => skillMapSetForRuleset(profile.activeRulesetRevisionId ? profile.rulesets[profile.activeRulesetRevisionId] : undefined))
  const scope = useRef(routeWithoutOverlays(navigation.route))
  const [drafts, setDrafts] = useState<readonly Draft[]>([])
  const [activeId, setActiveId] = useState('')
  const [selectedPosition, setSelectedPosition] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState<string>()
  const [closeWarning, setCloseWarning] = useState(false)
  const [search, setSearch] = useState('')
  const [allClasses, setAllClasses] = useState(false)
  const retained = useRef<readonly ScreenshotPreview[]>([])
  const controller = useRef<AbortController | undefined>(undefined)
  const blocked = useRef(false)
  const exitAllowed = useRef(false)
  blocked.current = !exitAllowed.current && (drafts.length > 0 || busy)
  useNavigationBlocker(scope.current, () => blocked.current, () => setCloseWarning(true))
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (blocked.current) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', beforeUnload)
    return () => { controller.current?.abort(); releaseScreenshotPreviews(retained.current); window.removeEventListener('beforeunload', beforeUnload) }
  }, [])
  const options = useMemo(() => choices(profile, catalogs), [profile, catalogs])
  const classes = options.filter(option => option.kind === 'class')
  const active = drafts.find(draft => draft.preview.id === activeId)
  const activeClass = active?.classRef ? resolveDefinition(profile, catalogs, active.classRef)?.name : undefined
  const classMatch = active?.classMatch
  const classHint = [`Selected row reads: ${active?.preview.className || 'Unrecognized'}`, classMatch?.kind === 'normalized' || classMatch?.kind === 'approximate' ? `Suggested ${classMatch.choice.name}; check it against the screenshot` : classMatch?.kind === 'ambiguous' ? 'More than one class matches; choose the class shown in the screenshot' : ''].filter(Boolean).join('. ')
  const suggestedMap = active?.classRef ? suggestSkillTreeMap(profile, catalogs, active.classRef, active.preview.squares, mapSetId, ruleset.current, active.mappings).confirmedMap : undefined
  const activeMap = suggestedMap && suggestedMap.mappings.every(mapping => active?.mappings.some(assigned => squareKey(assigned) === squareKey(mapping))) ? suggestedMap : undefined
  const mapSet = CONFIRMED_SKILL_MAP_SETS.find(set => set.id === mapSetId)
  const square = active?.preview.squares.find(entry => squareKey(entry) === selectedPosition) ?? active?.preview.squares[0]
  const mapping = square ? active?.mappings.find(entry => squareKey(entry) === squareKey(square)) : undefined
  const candidates = options.filter(option => option.kind !== 'class' && (allClasses || !activeClass || option.className === activeClass || mapping && sameLogicalEntity(profile, option.ref, mapping.ref)) && option.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
  const included = drafts.filter(draft => draft.included && !draft.preview.error && !draft.preview.duplicateOf)
  const ready = included.length > 0 && included.every(draft => draft.reviewed && draft.classRef && draft.characterId)
  const stale = profile.id !== profileId.current || profile.revision !== revision.current || profile.activeRulesetRevisionId !== ruleset.current
  const finish = () => { exitAllowed.current = true; blocked.current = false; controller.current?.abort(); navigation.close() }
  const requestClose = () => { if (blocked.current) { setCloseWarning(true); return false } return true }
  const update = (patch: Partial<Draft>) => { if (active) setDrafts(current => current.map(draft => draft.preview.id === active.preview.id ? { ...draft, ...patch } : draft)) }
  const setClass = (ref?: EntityRef) => {
    if (!active) return
    const inBatch = ref ? drafts.find(draft => draft.classRef && sameLogicalEntity(profile, ref, draft.classRef) && skillTreeShape(draft.preview.squares) === skillTreeShape(active.preview.squares)) : undefined
    update({ classRef: ref, classMatch: undefined, mappings: ref ? suggestSkillTreeMap(profile, catalogs, ref, active.preview.squares, mapSetId, ruleset.current, inBatch?.mappings).mappings : [], reviewed: false })
    setAllClasses(false)
    setSearch('')
  }
  const setMapping = (choice?: Choice) => {
    if (!active || !square) return
    const next = active.mappings.filter(entry => squareKey(entry) !== squareKey(square))
    if (choice) next.push({ row: square.row, column: square.column, ref: choice.ref, kind: choice.kind as LearnedNodeKind })
    next.sort((a, b) => a.row - b.row || a.column - b.column)
    setDrafts(current => current.map(draft => draft.classRef && active.classRef && sameLogicalEntity(profile, draft.classRef, active.classRef) && skillTreeShape(draft.preview.squares) === skillTreeShape(active.preview.squares) ? { ...draft, mappings: next, reviewed: false } : draft))
  }
  const selectFiles = async (files: File[]) => {
    setBusy(true); setError(undefined); setProgress('Reading screenshots...')
    controller.current = new AbortController()
    try {
      const previews = await previewSkillScreenshots(files, (done, total) => setProgress(`Reading screenshots: ${done} / ${total}`), controller.current.signal)
      if (controller.current.signal.aborted) { releaseScreenshotPreviews(previews); return }
      releaseScreenshotPreviews(retained.current)
      retained.current = previews
      const next = previews.map(preview => {
        const classMatch = matchScreenshotClassName(classes, preview.className)
        const classRef = 'choice' in classMatch ? classMatch.choice.ref : undefined
        const characterId = uniqueName(Object.values(profile.characters), preview.characterName)?.id
        return { preview, characterId, classRef, classMatch, mappings: classRef ? suggestSkillTreeMap(profile, catalogs, classRef, preview.squares, mapSetId, ruleset.current).mappings : [], reviewed: false, included: !preview.error && !preview.duplicateOf }
      })
      setDrafts(next); setActiveId(next.find(draft => draft.included)?.preview.id ?? next[0]?.preview.id ?? ''); setSelectedPosition('')
    } catch (reason) { if (!controller.current.signal.aborted) setError(reason instanceof Error ? reason.message : 'The screenshots could not be read') }
    finally { setBusy(false); setProgress('') }
  }
  const save = async () => {
    if (!ready || stale) return
    setBusy(true); setError(undefined)
    try {
      await onImport(included.map(draft => ({ characterId: draft.characterId!, classRef: draft.classRef!, rulesetRevisionId: ruleset.current, sourceDigest: draft.preview.digest!, filename: draft.preview.filename, squares: draft.preview.squares, mappings: draft.mappings, reviewed: draft.reviewed })), revision.current)
      finish()
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'The screenshot import could not be saved') }
    finally { setBusy(false) }
  }
  return <Sheet description="Read local Learn-menu screenshots, review the character and class, then save observations." onClose={finish} onRequestClose={requestClose} open title="Import skill screenshots" width="wide">
    <div className="stack">
      {drafts.length === 0 && <p>Gold squares are learned. Blue squares are available but not learned; dim squares are locked. Screenshots stay on this device.</p>}
      {drafts.length === 0 && <Field hint="Choose the game's configuration to fill names from confirmed class maps. Saved playthrough maps are preserved." label="Class maps"><select aria-label="Class maps" disabled={busy} onChange={event => setMapSetId(event.target.value)} value={mapSetId}><option value="">Saved playthrough maps only</option>{CONFIRMED_SKILL_MAP_SETS.map(set => <option key={set.id} value={set.id}>{set.label}</option>)}</select></Field>}
      {mapSet && <details><summary>View map configuration</summary><p>{mapSet.platform}. Game version: {mapSet.gameVersion ?? 'unreported'}.</p><p><strong>Enabled:</strong> {mapSet.enabledMods.join(', ')}</p><p><strong>Disabled:</strong> {mapSet.disabledMods.join(', ')}</p></details>}
      {drafts.length === 0 && <Field hint="Full 16:9 PNG or JPEG captures. Duplicates are skipped; source files are unchanged." label="Skill screenshots"><input aria-label="Skill screenshots" accept="image/png,image/jpeg,.png,.jpg,.jpeg" disabled={busy || drafts.length > 0} multiple onChange={event => { const files = [...(event.target.files ?? [])]; if (files.length) void selectFiles(files); event.target.value = '' }} type="file"/></Field>}
      {busy && <p role="status">{progress || 'Saving reviewed observations...'}</p>}
      {closeWarning && <InlineNotice title="Unsaved screenshot review" tone="warning">Finish the review or use Cancel and discard to close it.</InlineNotice>}
      {error && <InlineNotice title="Screenshot import not saved" tone="danger">{error} The review is retained. If storage failed, close this review and use Retry save or export a recovery backup.</InlineNotice>}
      {stale && <InlineNotice title="Playthrough changed" tone="warning">Close and reopen this review before importing into the updated playthrough.</InlineNotice>}
      {drafts.length > 0 && <>
        <p role="status">{included.length} included · {drafts.filter(draft => draft.preview.duplicateOf).length} duplicates skipped · {drafts.filter(draft => draft.preview.error).length} unreadable</p>
        <Field label="Screenshot to review"><select aria-label="Screenshot to review" disabled={busy} onChange={event => { setActiveId(event.target.value); setSelectedPosition(''); setSearch('') }} value={activeId}>{drafts.map((draft, index) => <option key={draft.preview.id} value={draft.preview.id}>{index + 1}. {draft.preview.className || draft.preview.filename} {draft.preview.error ? '(unreadable)' : draft.preview.duplicateOf ? '(duplicate)' : draft.reviewed ? '(reviewed)' : draft.included ? '(needs review)' : '(excluded)'}</option>)}</select></Field>
        {active && <fieldset className="skill-review-fields" disabled={busy}>
          <details className="skill-filename"><summary>Image filename</summary>{active.preview.filename}</details>
          {active.preview.duplicateOf ? <InlineNotice title="Duplicate skipped">Identical decoded pixels to {active.preview.duplicateOf}.</InlineNotice> : active.preview.error ? <InlineNotice title="Screenshot not recognized" tone="warning">{active.preview.error}</InlineNotice> : <>
            <label className="check-row"><input checked={active.included} onChange={event => update({ included: event.target.checked })} type="checkbox"/>Include this screenshot</label>
            <div className="grid-2">
              <Field hint={`Screenshot reads: ${active.preview.characterName || 'Unrecognized'}`} label="Screenshot character"><select aria-label="Screenshot character" onChange={event => update({ characterId: event.target.value as CharacterId || undefined, reviewed: false })} value={active.characterId ?? ''}><option value="">Choose a character</option>{Object.values(profile.characters).map(character => <option key={character.id} value={character.id}>{character.name}</option>)}</select></Field>
              <Field hint={classHint} label="Screenshot class"><select aria-label="Screenshot class" onChange={event => setClass(classes.find(choice => entityDefinitionKey(choice.ref) === event.target.value)?.ref)} value={active.classRef ? entityDefinitionKey(active.classRef) : ''}><option value="">Choose a class</option>{classes.map(choice => <option key={entityDefinitionKey(choice.ref)} value={entityDefinitionKey(choice.ref)}>{choiceLabel(choice)}</option>)}</select></Field>
            </div>
            <div className="skill-review-layout">
              <div>
                <div aria-label="Detected skill squares" className="skill-tree-preview" role="group">
                  <img alt="Skill tree from the selected screenshot" src={active.preview.imageUrl}/>
                  {active.preview.squares.map((entry, index) => <button aria-label={`Square ${index + 1}, row ${entry.row + 1}, column ${entry.column + 1}: ${SQUARE_LABELS[entry.state]}`} aria-pressed={squareKey(entry) === (square && squareKey(square))} className={`skill-square skill-square--${entry.state}`} key={squareKey(entry)} onClick={() => { setSelectedPosition(squareKey(entry)); setSearch('') }} style={{ left: `${(GRID_X + entry.column * GRID_STEP - 650) / 275 * 100}%`, top: `${(GRID_Y + entry.row * GRID_STEP - 175) / 425 * 100}%`, width: `${SQUARE_SIZE / 275 * 100}%`, height: `${SQUARE_SIZE / 425 * 100}%` }} type="button"><span>{index + 1}</span></button>)}
                </div>
                <details><summary>Show full screenshot</summary><img alt="Full screenshot with character header and selected class" className="skill-full-image" src={active.preview.imageUrl}/></details>
              </div>
              <div className="stack">
                {activeMap ? <InlineNotice title={`${activeClass} ${activeMap.mappings.length === activeMap.squares.length ? 'names filled' : 'known names filled'}`}>{mapSet?.label}. The bundled names were checked in game.{activeMap.mappings.length < activeMap.squares.length && <> Assign any remaining unconfirmed positions when their names are established.</>} Review the assigned names against your screenshot before saving.</InlineNotice> : <InlineNotice title="Review square names">Assign any missing names to their positions. This playthrough reuses reviewed mappings for the same class, ruleset, and grid. Unmapped squares stay unresolved.</InlineNotice>}
                {square && <>
                  <h3>Row {square.row + 1}, column {square.column + 1}</h3>
                  <Field label="Square state"><select aria-label="Square state" onChange={event => update({ preview: { ...active.preview, squares: active.preview.squares.map(entry => squareKey(entry) === squareKey(square) ? { ...entry, state: event.target.value as SkillSquareState } : entry) }, reviewed: false })} value={square.state}>{Object.entries(SQUARE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
                  <Field label="Find an ability"><input disabled={!active.classRef} onChange={event => setSearch(event.target.value)} type="search" value={search}/></Field>
                  <label className="check-row"><input checked={allClasses} onChange={event => setAllClasses(event.target.checked)} type="checkbox"/>Show definitions from all classes</label>
                  <Field label="Ability for selected square"><select aria-label="Ability for selected square" disabled={!active.classRef} onChange={event => setMapping(options.find(choice => entityDefinitionKey(choice.ref) === event.target.value))} value={mapping ? entityDefinitionKey(mapping.ref) : ''}><option value="">Unresolved ability</option>{mapping && !candidates.some(choice => sameLogicalEntity(profile, choice.ref, mapping.ref)) && <option value={entityDefinitionKey(mapping.ref)}>{resolveDefinition(profile, catalogs, mapping.ref)?.name}</option>}{candidates.map(choice => <option key={entityDefinitionKey(choice.ref)} value={entityDefinitionKey(choice.ref)}>{choiceLabel(choice)} ({choice.kind})</option>)}</select></Field>
                </>}
              </div>
            </div>
            <div className="skill-compiled-list" role="group" aria-label="Compiled learning observations">
              {active.preview.squares.map((entry, index) => { const linked = active.mappings.find(item => squareKey(item) === squareKey(entry)); return <button className="skill-compiled-row" key={squareKey(entry)} onClick={() => { setSelectedPosition(squareKey(entry)); setSearch('') }} type="button"><span>{index + 1}. {linked ? resolveDefinition(profile, catalogs, linked.ref)?.name : 'Unresolved ability'}</span><span>{SQUARE_LABELS[entry.state]}</span></button> })}
            </div>
            <p>{active.preview.squares.filter(entry => entry.state === 'learned').length} learned squares · {active.preview.squares.length - active.mappings.length} unresolved names</p>
            <label className="check-row"><input checked={active.reviewed} disabled={!active.classRef || !active.characterId} onChange={event => update({ reviewed: event.target.checked })} type="checkbox"/>I reviewed this character, class, square states, and assigned names</label>
          </>}
        </fieldset>}
      </>}
      <div className="form-actions"><Button disabled={busy && !progress} onClick={finish} tone="quiet">{error ? 'Close review' : drafts.length || busy ? 'Cancel and discard' : 'Cancel'}</Button><Button disabled={busy || !ready || stale} icon="check" onClick={() => void save()}>Save reviewed screenshots</Button></div>
      <p className="field__hint">Saving preserves unresolved squares and existing learning conflicts. It does not set mastery or paid LP. One Undo removes the batch.</p>
    </div>
  </Sheet>
}
