import { useState } from 'react'
import { entityDefinitionKey } from '../domain'
import type { CatalogSnapshot, Character, LearnedNodeKind, Profile } from '../domain/types'
import { Badge, Button, Field, IconButton } from './components'
import { MemberArtwork } from './MemberSheet'
import { entityName, knowledgeLabel } from './model'
import { useNavigation } from './navigation'

const LEARNING_KINDS: Record<LearnedNodeKind, string> = { ability: 'Ability', passive: 'Passive', innate: 'Innate', monsterMagic: 'Monster Magic' }

export function CharacterLearning({ profile, catalogs, character, initialKind = 'all' }: { profile: Profile; catalogs: readonly CatalogSnapshot[]; character: Character; initialKind?: 'all' | LearnedNodeKind }) {
  const navigation = useNavigation()
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState(initialKind)
  const classes = Object.values(character.classProgress)
  const nodes = Object.values(character.learnedNodes).filter(node => (kind === 'all' || node.kind === kind) && entityName(profile, catalogs, node.ref).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const captures = Object.values(profile.skillTreeCaptures ?? {}).filter(capture => capture.characterId === character.id)
  return <section className="member-learning" aria-label="Character learning">
    <header className="member-learning__header"><div><h3>Learn</h3><p>Class progress and skills recorded for {character.name}.</p></div><Button icon="upload" onClick={() => navigation.navigate({ page: { page: 'characters', view: 'skill-screenshots', characterId: character.id }, overlays: [], query: {} })} tone="secondary">Import skill screenshots</Button></header>
    <div className="member-learning__layout">
      <section aria-label="Class progress"><div className="split"><h4>Classes</h4><Button icon="plus" onClick={() => navigation.navigate({ page: { page: 'characters', view: 'class-new', characterId: character.id }, overlays: [], query: {} })} tone="quiet">Add class</Button></div>
        {classes.length ? classes.map(progress => <article className="member-class" key={entityDefinitionKey(progress.classRef)}><div className="member-class__title"><MemberArtwork catalogs={catalogs} profile={profile} value={progress.classRef}/><strong>{entityName(profile, catalogs, progress.classRef)}</strong><IconButton icon="edit" label={`Edit ${entityName(profile, catalogs, progress.classRef)}`} onClick={() => navigation.navigate({ page: { page: 'characters', view: 'class-edit', characterId: character.id, ref: progress.classRef }, overlays: [], query: {} })}/></div><dl><div><dt>Unlocked</dt><dd>{knowledgeLabel(progress.unlocked, value => value ? 'Yes' : 'No')}</dd></div><div><dt>LP</dt><dd>{knowledgeLabel(progress.observedLp)}</dd></div><div><dt>Core tree</dt><dd>{knowledgeLabel(progress.coreTreeComplete, value => value ? 'Complete' : 'Incomplete')}</dd></div><div><dt>Mastered</dt><dd>{knowledgeLabel(progress.mastered, value => value ? 'Yes' : 'No')}</dd></div></dl></article>) : <p className="member-learning__empty">No class progress recorded.</p>}
      </section>
      <section aria-label="Learned skills"><div className="split"><h4>Skills</h4><Button icon="plus" onClick={() => navigation.navigate({ page: { page: 'characters', view: 'learning-new', characterId: character.id, learningKind: kind === 'monsterMagic' ? 'magic' : 'knowledge' }, overlays: [], query: {} })} tone="quiet">{kind === 'monsterMagic' ? 'Add spell' : 'Add learning'}</Button></div>
        <div className="member-learning__filters"><Field label="Find a skill"><input onChange={event => setQuery(event.target.value)} placeholder="Search skills..." type="search" value={query}/></Field><Field label="Skill type"><select onChange={event => setKind(event.target.value as typeof kind)} value={kind}><option value="all">All skills</option>{Object.entries(LEARNING_KINDS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field></div>
        {nodes.length ? <div className="member-skills">{nodes.map(node => <div className="member-skill" key={entityDefinitionKey(node.ref)}><div><strong>{entityName(profile, catalogs, node.ref)}</strong><small>{LEARNING_KINDS[node.kind]} · Paid LP: {knowledgeLabel(node.actualPaidLp)}</small></div><Badge tone={node.learned.state === 'known' && node.learned.value ? 'positive' : 'neutral'}>{knowledgeLabel(node.learned, value => value ? 'Learned' : 'Not learned')}</Badge><IconButton icon="edit" label={`Edit ${entityName(profile, catalogs, node.ref)}`} onClick={() => navigation.navigate({ page: { page: 'characters', view: 'learning-edit', characterId: character.id, learningKind: node.kind === 'monsterMagic' ? 'magic' : 'knowledge', ref: node.ref }, overlays: [], query: {} })}/></div>)}</div> : <p className="member-learning__empty">{query || kind !== 'all' ? 'No matching learning records.' : 'No skills recorded yet. Add an observation or import a Learn screenshot.'}</p>}
      </section>
    </div>
    {captures.length > 0 && <details className="member-record"><summary>Imported skill screenshots</summary>{captures.map(capture => <div className="list-row" key={capture.id}><div className="list-row__primary"><strong>{entityName(profile, catalogs, capture.classRef)} screenshot</strong><small>{capture.squares.filter(square => square.state === 'learned').length} learned squares · {capture.squares.length - capture.mappings.length} unresolved names</small></div></div>)}</details>}
  </section>
}
