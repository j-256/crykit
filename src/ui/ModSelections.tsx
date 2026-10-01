import { useState } from 'react'
import { SWITCH_MOD_PACKS } from '../catalog/mods'
import { assertModConfiguration, modState, normalizeModName, recordedModNames, updateModSelections, type ModConfiguration, type ModSelection } from '../domain/mods'
import { Badge, Button, Field, InlineNotice } from './components'

const KNOWN_NAMES = new Map(SWITCH_MOD_PACKS.flatMap(pack => pack.mods.map(name => [normalizeModName(name), name] as const)))

export function ModSelections({ value, onChange }: { readonly value: ModConfiguration; readonly onChange: (value: ModConfiguration) => void }) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string>()
  const custom = recordedModNames(value).filter(name => !KNOWN_NAMES.has(normalizeModName(name)))
  const choice = (name: string) => {
    const state = modState(value, name)
    return <label className="game-setup-mod-choice" key={normalizeModName(name)}><span>{name}</span><select aria-label={name} data-mod-state={state} onChange={event => onChange(updateModSelections(value, [{ name, state: event.target.value as ModSelection['state'] }]))} value={state}><option value="unknown">Unknown</option><option value="enabled">Enabled</option><option value="disabled">Disabled</option>{state === 'conflicting' && <option disabled value="conflicting">Conflicting</option>}</select></label>
  }
  const add = () => {
    try {
      const entered = name.trim()
      if (!entered) return
      const key = normalizeModName(entered)
      const canonical = KNOWN_NAMES.get(key) ?? custom.find(name => normalizeModName(name) === key) ?? entered
      const configuration = KNOWN_NAMES.has(key) ? value : { ...value, customMods: [...new Map([...(value.customMods ?? []), canonical].map(name => [normalizeModName(name), name])).values()] }
      const next = updateModSelections(configuration, [{ name: canonical, state: 'enabled' }])
      assertModConfiguration(next)
      onChange(next)
      setName('')
      setError(undefined)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'The mod could not be added.') }
  }
  return <div className="stack">
    <div className="grid-2 game-setup-mod-packs">{SWITCH_MOD_PACKS.map(pack => {
      const states = pack.mods.map(name => modState(value, name))
      const enabled = states.filter(state => state === 'enabled').length
      const unresolved = states.filter(state => state === 'unknown' || state === 'conflicting').length
      return <details className="game-setup-mod-pack" key={pack.id}><summary><span><strong>{pack.name}</strong><small>{enabled} of {pack.mods.length} enabled · {unresolved} need review</small></span>{unresolved > 0 && <Badge tone="warning">Review</Badge>}</summary><div className="game-setup-mod-pack__body">{pack.mods.map(choice)}</div></details>
    })}</div>
    {custom.length > 0 && <section aria-label="Custom mod choices" className="stack"><h4>Custom mods</h4><div className="game-setup-mod-pack__body">{custom.map(choice)}</div></section>}
    <div className="cluster mod-choice-add"><Field hint="Add one name to create an individual mod choice." label="Custom mod name"><input aria-label="Custom mod name" onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); add() } }} placeholder="Name a custom mod" value={name}/></Field><Button disabled={!name.trim()} onClick={add} tone="secondary" type="button">Add mod</Button></div>
    {error && <InlineNotice title="Mod not added" tone="danger">{error}</InlineNotice>}
  </div>
}
