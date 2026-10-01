import { useMemo, useState } from 'react'
import { CONFIRMED_SWITCH_MOD_SETUP, SWITCH_MOD_PACKS } from '../catalog/mods'
import { buildBehavior, sameBuildBehavior, type BuildBehavior } from '../domain/build-behavior'
import { SUGGESTED_BUILD_SLOTS } from '../domain/build-planning'
import { DEFAULT_GAME_VERSION, DEFAULT_PP_LIMIT } from '../domain/local-data'
import { definitionLineageRootRef } from '../domain/definitions'
import { recordedModNames } from '../domain/mods'
import type { Knowledge, LocalData } from '../domain/types'
import { Badge, Button, Field, InlineNotice } from './components'
import { Icon } from './icons'
import { ModSelections } from './ModSelections'

const PRESET = Object.freeze({ CUSTOM: 'custom', VANILLA: 'vanilla', NINTENDO: 'nintendo' })
const KNOWN_MODS = SWITCH_MOD_PACKS.flatMap(pack => pack.mods)
const textValue = (value: Knowledge<string>) => value.state === 'known' ? value.value : ''
const knowledgeLabel = (value: Knowledge<string>) => value.state === 'known' ? value.value : value.state === 'conflicting' ? 'Conflicting' : value.state === 'notApplicable' ? 'Not applicable' : 'Unknown'

export function BuildBehaviorEditor({ localData, value, onChange }: { readonly localData: LocalData; readonly value: BuildBehavior; readonly onChange: (value: BuildBehavior) => void }) {
  const [customVersion, setCustomVersion] = useState(false)
  const presets = useMemo(() => Object.values(localData.gameSetups).sort((left, right) => left.label.localeCompare(right.label) || right.revision - left.revision), [localData.gameSetups])
  const matches = presets.filter(setup => sameBuildBehavior(value, setup))
  const match = matches.find(setup => setup.label === value.label) ?? matches[0]
  const selected = match?.id ?? PRESET.CUSTOM
  const versions = [...new Set([DEFAULT_GAME_VERSION, ...presets.flatMap(setup => setup.gameVersion.state === 'known' ? [setup.gameVersion.value] : []), ...(value.gameVersion.state === 'known' ? [value.gameVersion.value] : [])])]
  const enabled = value.mods.state === 'known' ? value.mods.value.length : undefined
  const incompatibleOverrides = (value.definitionOverrides ?? []).filter(ref => {
    const root = definitionLineageRootRef(localData, ref)
    return root.kind === 'catalog' && value.catalogLock[root.catalogId] !== root.catalogRevisionId
  })
  const update = (change: Partial<BuildBehavior>) => onChange({ ...value, ...change })
  const preset = (id: string) => {
    const saved = localData.gameSetups[id]
    if (saved) { onChange({ ...buildBehavior(saved), slots: saved.slots.length ? saved.slots : SUGGESTED_BUILD_SLOTS }); return }
    if (id === PRESET.CUSTOM) return
    const catalogLock = value.modComposition ? { ...value.catalogLock, [value.modComposition.baseline.catalogId]: value.modComposition.baseline.catalogRevisionId } : value.catalogLock
    const base = { ...value, catalogLock, modComposition: undefined, ppLimit: { state: 'known' as const, value: DEFAULT_PP_LIMIT }, ppCostsNonNegative: { state: 'known' as const, value: true } }
    onChange(id === PRESET.VANILLA
      ? { ...base, label: 'Unmodified game', mode: { state: 'known', value: 'Vanilla' }, mods: { state: 'known', value: [] }, disabledMods: { state: 'known', value: [...new Set([...KNOWN_MODS, ...recordedModNames(value)])] } }
      : { ...base, label: CONFIRMED_SWITCH_MOD_SETUP.label, platform: { state: 'known', value: CONFIRMED_SWITCH_MOD_SETUP.platform }, gameVersion: { state: 'unknown' }, mode: { state: 'unknown' }, mods: { state: 'known', value: CONFIRMED_SWITCH_MOD_SETUP.enabledMods }, disabledMods: { state: 'known', value: CONFIRMED_SWITCH_MOD_SETUP.disabledMods } })
  }
  const textChoice = (key: 'platform' | 'mode', label: string, choices: readonly string[]) => <Field label={label}><select aria-label={label} onChange={event => update({ [key]: event.target.value ? { state: 'known', value: event.target.value } : { state: 'unknown' } })} value={textValue(value[key])}><option value="">{value[key].state === 'known' ? 'Unknown' : knowledgeLabel(value[key])}</option>{[...new Set([...choices, ...(value[key].state === 'known' ? [value[key].value] : [])])].map(name => <option key={name} value={name}>{name}</option>)}</select></Field>
  return <details className="build-behavior panel">
    <summary><span><strong>Build behavior</strong><small>{match?.label ?? value.label} · {knowledgeLabel(value.gameVersion)} · {enabled === undefined ? 'Mods unresolved' : `${enabled} mods enabled`}</small></span>{!match && <Badge tone="info">Customized</Badge>}<Icon name="chevron-down"/></summary>
    <div className="panel__body stack">
      <p>These rules belong to this build checkpoint. Saving preserves earlier checkpoints and your Playthrough setup.</p>
      <Field label="Behavior preset"><select aria-label="Behavior preset" onChange={event => preset(event.target.value)} value={selected}><option value={PRESET.CUSTOM}>Custom behavior</option><option value={PRESET.VANILLA}>Unmodified game</option><option value={PRESET.NINTENDO}>{CONFIRMED_SWITCH_MOD_SETUP.label}</option>{presets.map(setup => <option key={setup.id} value={setup.id}>{setup.label} · r{setup.revision}</option>)}</select></Field>
      <div className="grid-3">{textChoice('platform', 'Build platform', ['Nintendo Switch', 'PC'])}<Field label="Build game version"><select aria-label="Build game version" onChange={event => update({ gameVersion: event.target.value ? { state: 'known', value: event.target.value } : { state: 'unknown' } })} value={textValue(value.gameVersion)}><option value="">{value.gameVersion.state === 'known' ? 'Unknown' : knowledgeLabel(value.gameVersion)}</option>{versions.map(version => <option key={version} value={version}>{version}</option>)}</select><Button onClick={() => setCustomVersion(value => !value)} tone="quiet" type="button">Enter exact version</Button>{customVersion && <input aria-label="Exact build game version" onChange={event => update({ gameVersion: event.target.value.trim() ? { state: 'known', value: event.target.value.trim() } : { state: 'unknown' } })} placeholder="Exact game version" value={textValue(value.gameVersion)}/>}</Field>{textChoice('mode', 'Build game mode', ['Standard', 'Vanilla', 'Chaos'])}</div>
      <div className="grid-2"><Field label="Build passive PP limit"><input aria-label="Build passive PP limit" min="0" onChange={event => update({ ppLimit: event.target.value === '' ? { state: 'unknown' } : { state: 'known', value: Number(event.target.value) } })} step="1" type="number" value={value.ppLimit?.state === 'known' ? value.ppLimit.value : ''}/></Field><Field label="Build PP cost rule"><select aria-label="Build PP cost rule" onChange={event => update({ ppCostsNonNegative: event.target.value === '' ? { state: 'unknown' } : { state: 'known', value: event.target.value === 'true' } })} value={value.ppCostsNonNegative.state === 'known' ? String(value.ppCostsNonNegative.value) : ''}><option value="">{value.ppCostsNonNegative.state === 'conflicting' ? 'Conflicting' : 'Unknown'}</option><option value="true">Cannot be negative</option><option value="false">Negative values permitted</option></select></Field></div>
      <h3>Mods</h3><ModSelections value={value} onChange={configuration => update(configuration)}/>
      {incompatibleOverrides.length > 0 && <InlineNotice title="Override pins need review" tone="warning">Some personal overrides use another catalog revision. Their exact definitions remain saved. <Button onClick={() => update({ definitionOverrides: value.definitionOverrides?.filter(ref => !incompatibleOverrides.includes(ref)) })} tone="secondary" type="button">Remove incompatible override pins from this behavior</Button></InlineNotice>}
    </div>
  </details>
}
