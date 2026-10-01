import { useState } from 'react'
import { CONFIRMED_SWITCH_MOD_SETUP, SWITCH_MOD_PACKS } from '../catalog/mods'
import { buildBehavior, sameBuildBehavior, type BuildBehavior } from '../domain/build-behavior'
import { SUGGESTED_BUILD_SLOTS } from '../domain/build-planning'
import { createId, requirePlaythrough } from '../domain'
import { latestGameSetups } from '../domain/game-setups'
import { DEFAULT_GAME_MODE, DEFAULT_PP_LIMIT } from '../domain/local-data'
import { recordedModNames } from '../domain/mods'
import type { LocalData, SlotId } from '../domain/types'
import { Badge, Field } from './components'
import { Icon } from './icons'
import { GameRulesFields, type GameSetupDraft } from './GameSetupEditor'
import { gameSetupModSummary, knowledgeLabel } from './model'

const PRESET = Object.freeze({ CUSTOM: 'custom', VANILLA: 'vanilla', NINTENDO: 'nintendo', PLAYTHROUGH: 'playthrough' })
const KNOWN_MODS = SWITCH_MOD_PACKS.flatMap(pack => pack.mods)

export function BuildBehaviorEditor({ localData, value, onChange, initiallyOpen = false }: { readonly localData: LocalData; readonly value: BuildBehavior; readonly onChange: (value: BuildBehavior) => void; readonly initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen)
  const presets = latestGameSetups(localData)
  const matches = Object.values(localData.gameSetups).filter(setup => sameBuildBehavior(value, setup))
  const match = matches.find(setup => setup.label === value.label) ?? matches[0]
  const selected = match?.id ?? PRESET.CUSTOM
  const choices = match && !presets.some(setup => setup.id === match.id) ? [match, ...presets] : presets
  const playthrough = requirePlaythrough(localData)
  const actual = playthrough.currentGameSetupRevisionId ? localData.gameSetups[playthrough.currentGameSetupRevisionId] : undefined
  const origin = value.modComposition ? Object.values(localData.gameSetups).find(setup => setup.modComposition && setup.catalogLock[value.modComposition!.baseline.catalogId] === value.catalogLock[value.modComposition!.baseline.catalogId]) : undefined
  const draft: GameSetupDraft = { ...value, ppLimit: value.ppLimit ?? { state: 'known', value: DEFAULT_PP_LIMIT } }
  const update = (changes: Partial<GameSetupDraft>) => {
    const next = { ...value, ...changes }
    onChange({ ...next, slots: next.slots.map((slot, order) => ({ ...slot, id: slot.id ?? createId<SlotId>('slot'), kind: 'equipment', order })) })
  }
  const preset = (id: string) => {
    const saved = id === PRESET.PLAYTHROUGH ? actual : localData.gameSetups[id]
    if (saved) { onChange({ ...buildBehavior(saved), slots: saved.slots.length ? saved.slots : SUGGESTED_BUILD_SLOTS }); return }
    if (id === PRESET.CUSTOM) return
    const catalogLock = value.modComposition ? { ...value.catalogLock, [value.modComposition.baseline.catalogId]: value.modComposition.baseline.catalogRevisionId } : value.catalogLock
    const base = { ...value, catalogLock, modComposition: undefined, ppLimit: { state: 'known' as const, value: DEFAULT_PP_LIMIT }, ppCostsNonNegative: { state: 'known' as const, value: true } }
    onChange(id === PRESET.VANILLA
      ? { ...base, label: 'Unmodified game', mods: { state: 'known', value: [] }, disabledMods: { state: 'known', value: [...new Set([...KNOWN_MODS, ...recordedModNames(value)])] } }
      : { ...base, label: CONFIRMED_SWITCH_MOD_SETUP.label, platform: { state: 'known', value: CONFIRMED_SWITCH_MOD_SETUP.platform }, gameVersion: { state: 'unknown' }, mode: { state: 'known', value: DEFAULT_GAME_MODE }, mods: { state: 'known', value: CONFIRMED_SWITCH_MOD_SETUP.enabledMods }, disabledMods: { state: 'known', value: CONFIRMED_SWITCH_MOD_SETUP.disabledMods } })
  }
  return <details className="build-behavior panel" onToggle={event => setOpen(event.currentTarget.open)} open={open}>
    <summary><span><strong>Game Setup</strong><small>{match?.label ?? value.label} · {knowledgeLabel(value.gameVersion)} · {gameSetupModSummary(value)}</small></span>{!match && <Badge tone="info">Customized</Badge>}<Icon name="chevron-down"/></summary>
    <div className="panel__body stack">
      <p>These rules are saved with this build checkpoint. Copy a Game Setup as a starting point, then adjust it here.</p>
      <Field label="Copy Game Setup" hint="Copies rules into this checkpoint. Your playthrough and other builds keep their own settings."><select aria-label="Copy Game Setup" onChange={event => preset(event.target.value)} value={selected}><option value={PRESET.CUSTOM}>Custom rules</option><optgroup label="Starting points"><option value={PRESET.VANILLA}>Unmodified game</option><option value={PRESET.NINTENDO}>{CONFIRMED_SWITCH_MOD_SETUP.label}</option>{actual && <option value={PRESET.PLAYTHROUGH}>From playthrough: {playthrough.label}</option>}</optgroup><optgroup label="Saved Game Setups">{choices.map(setup => <option key={setup.id} value={setup.id}>{setup.label} · r{setup.revision}</option>)}</optgroup></select></Field>
      <GameRulesFields current={origin} localData={localData} onChange={update} value={draft}/>
    </div>
  </details>
}
