import { useState } from 'react'
import { requirePlaythrough } from '../domain'
import { latestGameSetups } from '../domain/game-setups'
import { resolveGameRules } from '../domain/game-rules'
import type { GameSetupRevision, GameSetupRevisionId, LocalData, PlaythroughId } from '../domain/types'
import { Button, DefinitionRow, Field, InlineNotice } from './components'
import { useDefinitionLibrary } from './definitions'
import { gameSetupModSummary, knowledgeLabel } from './model'
import { useNavigation } from './navigation'

function GameSetupSummary({ setup }: { setup: GameSetupRevision }) {
  const library = useDefinitionLibrary()
  const rules = resolveGameRules(setup, library.catalogs)
  const difficulty = setup.difficulty?.selection
  const difficultyLabel = difficulty?.state === 'known' ? rules.difficulties.find(value => value.id === difficulty.value)?.name ?? `Unavailable difficulty ${difficulty.value}` : knowledgeLabel(difficulty ?? { state: 'unknown' })
  return <div className="playthrough-game-summary"><strong>{setup.label} · revision {setup.revision}</strong><dl className="definition-list"><DefinitionRow term="Game version">{knowledgeLabel(setup.gameVersion)}</DefinitionRow><DefinitionRow term="Difficulty">{difficultyLabel}</DefinitionRow><DefinitionRow term="Mods">{gameSetupModSummary(setup)}</DefinitionRow></dl></div>
}

export function PlaythroughSettings({ localData, disabled, onSelect, onCreate, onApply, run }: { localData: LocalData; disabled: boolean; onSelect: (id: PlaythroughId) => Promise<void>; onCreate: (label: string, setupId?: GameSetupRevisionId) => Promise<void>; onApply: (id: GameSetupRevisionId) => Promise<void>; run: (action: () => Promise<void>) => Promise<void> }) {
  const navigation = useNavigation()
  const playthrough = requirePlaythrough(localData)
  const current = playthrough.currentGameSetupRevisionId ? localData.gameSetups[playthrough.currentGameSetupRevisionId] : undefined
  const [label, setLabel] = useState('')
  const [startingSetup, setStartingSetup] = useState('')
  const [applySetup, setApplySetup] = useState<string>()
  const choices = latestGameSetups(localData)
  const selectedSetupId = applySetup ?? current?.id ?? ''
  const selectedSetup = localData.gameSetups[selectedSetupId]
  const manageSetups = () => navigation.navigate({ page: { page: 'settings', section: 'game-setup' }, overlays: [], query: {} })
  return <div className="stack playthrough-settings">
    <section className="settings-section stack"><div><h2>Playthrough</h2><p className="settings-section__intro">Track a game save's characters, inventory, progress, and party plans.</p></div>
      <Field label="Active Playthrough"><select disabled={disabled} onChange={event => void run(async () => { await onSelect(event.target.value as PlaythroughId); setApplySetup(undefined) })} value={playthrough.id}>{Object.values(localData.playthroughs).sort((left, right) => left.label.localeCompare(right.label)).map(entry => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select></Field>
      <details className="playthrough-create"><summary>New Playthrough</summary><div className="stack"><Field label="New blank Playthrough"><input disabled={disabled} onChange={event => setLabel(event.target.value)} placeholder="Playthrough name" value={label}/></Field><Field label="Starting Game Setup"><select disabled={disabled} onChange={event => setStartingSetup(event.target.value)} value={startingSetup}><option value="">Fresh settings (Standard mode; platform, version, and mods unknown)</option>{choices.map(setup => <option key={setup.id} value={setup.id}>Use {setup.label} · revision {setup.revision}</option>)}</select></Field><p className="field__hint">Characters, inventory, progress, and party plans start empty. Your Builds and Teams stay available.</p><Button disabled={disabled || !label.trim()} icon="plus" onClick={() => void run(async () => { await onCreate(label, startingSetup as GameSetupRevisionId || undefined); setLabel(''); setStartingSetup(''); setApplySetup(undefined) })} tone="secondary">Create</Button></div></details>
    </section>
    <section className="settings-section stack"><div><h3>Game Setup used for tracking</h3><p className="settings-section__intro">Choose the saved rules that match {playthrough.label}. Create or edit game rules in Saved setups.</p></div>
      {current ? <GameSetupSummary setup={current}/> : <InlineNotice title="No Game Setup selected">Choose a saved setup to record the rules this game uses.</InlineNotice>}
      <Field label="Game Setup to apply"><select disabled={disabled} onChange={event => setApplySetup(event.target.value)} value={selectedSetupId}><option value="">Choose a saved revision</option>{Object.values(localData.gameSetups).sort((left, right) => left.label.localeCompare(right.label) || right.revision - left.revision).map(setup => <option key={setup.id} value={setup.id}>{setup.label} · revision {setup.revision}</option>)}</select></Field>
      {selectedSetup && selectedSetup.id !== current?.id && <div className="stack playthrough-game-preview"><p className="field__hint">Will use after applying:</p><GameSetupSummary setup={selectedSetup}/></div>}
      <p className="field__hint">Apply updates this Playthrough's tracking context. Builds, Teams, and earlier character snapshots keep their recorded rules.</p>
      <div className="cluster"><Button disabled={disabled || !selectedSetup || selectedSetup.id === current?.id} icon="check" onClick={() => void run(async () => { await onApply(selectedSetupId as GameSetupRevisionId); setApplySetup(undefined) })}>Apply to {playthrough.label}</Button><Button disabled={disabled} icon="settings" onClick={manageSetups} tone="quiet">Manage saved setups</Button></div>
    </section>
  </div>
}
