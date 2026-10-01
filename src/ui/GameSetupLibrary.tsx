import { latestGameSetups } from '../domain/game-setups'
import type { LocalData } from '../domain/types'
import { Button } from './components'
import { knowledgeLabel } from './model'
import { useNavigation } from './navigation'

export function GameSetupLibrary({ localData }: { localData: LocalData }) {
  const navigation = useNavigation()
  const edit = (id: string) => navigation.navigate({ page: { page: 'settings', section: 'game-setup' }, overlays: [], query: { gameSetup: [id] } })
  return <div className="stack game-setup-library">
    <header className="game-setup-library__header"><div className="game-setup-library__heading"><h2>Saved Game Setups</h2><p className="settings-section__intro">Reusable rules for buildcrafting: base game version, difficulty, and mods.</p></div><Button icon="plus" onClick={() => navigation.navigate({ page: { page: 'settings', section: 'game-setup' }, overlays: [], query: { new: ['true'] } })}>New Game Setup</Button></header>
    <p className="field__hint">Choose a setup when starting a build. Each saved checkpoint keeps its own rules. Apply a setup to your actual game under Playthrough.</p>
    {latestGameSetups(localData).map(setup => {
      const revisions = Object.values(localData.gameSetups).filter(value => value.gameSetupId === setup.gameSetupId).sort((left, right) => right.revision - left.revision)
      const revisionIds = new Set(revisions.map(value => value.id))
      const playthroughs = Object.values(localData.playthroughs).filter(value => value.currentGameSetupRevisionId && revisionIds.has(value.currentGameSetupRevisionId))
      const builds = Object.values(localData.builds).filter(build => Object.values(localData.buildRevisions).some(value => value.buildId === build.id && revisionIds.has(value.gameSetupRevisionId)))
      return <section className="panel game-setup-library__item stack" key={setup.gameSetupId}>
        <div className="game-setup-library__heading"><h3>{setup.label}</h3><p className="settings-section__intro">{knowledgeLabel(setup.platform)} · Version {knowledgeLabel(setup.gameVersion)} · Revision {setup.revision}</p></div>
        <div className="cluster"><Button icon="edit" onClick={() => edit(setup.id)} tone="secondary">Edit setup</Button><Button icon="sword" onClick={() => navigation.navigate({ page: { page: 'builds', view: 'build-new' }, overlays: [], query: { gameSetup: [setup.id] } })} tone="quiet">Start a Build</Button></div>
        <details><summary>Usage &amp; revision history</summary><div className="stack"><p className="field__hint">Playthroughs: {playthroughs.map(value => value.label).join(', ') || 'None'}. Builds: {builds.map(value => value.title).join(', ') || 'None'}. Each keeps its saved revision.</p><div className="cluster">{revisions.map(value => <Button data-game-setup-revision={value.id} key={value.id} onClick={() => edit(value.id)} tone="quiet">Revision {value.revision}</Button>)}</div></div></details>
      </section>
    })}
  </div>
}
