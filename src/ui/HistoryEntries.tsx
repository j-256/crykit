import type { ChangeEntry } from '../domain/types'
import { InlineNotice } from './components'
import { Icon } from './icons'
import { formatRelativeDate } from './model'

const HISTORY_VISIBLE_LIMIT = 100
const HISTORY_ACTION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  'mods.setup-configure': 'Mod choices saved',
  'mods.setup-skip': 'Mod selection skipped',
  'build.create': 'Build created',
  'build.revise': 'Build checkpoint saved',
  'build.rename': 'Build renamed',
  'build.clone': 'Build copied',
  'build.update': 'Build details updated',
  'build.saveRevision': 'Build checkpoint saved',
  'character.create': 'Character added',
  'character.update': 'Character details updated',
  'character.capture': 'Character sheet recorded',
  'character.classProgress.upsert': 'Character class progress updated',
  'character.learnedNode.upsert': 'Character learning recorded',
  'character.skillTrees.import': 'Character skill trees imported',
  'gameSetup.activate': 'Planning Game Setup selected',
  'gameSetup.addRevision': 'Game Setup saved',
  'goal.create': 'Goal created',
  'inventory.observe.create': 'Inventory item recorded',
  'inventory.observe.update': 'Inventory observation updated',
  'inventory.link': 'Inventory definition linked',
  'inventory.event.record': 'Inventory history recorded',
  'personalDefinition.create': 'Personal definition created',
  'personalDefinition.override': 'Personal definition updated',
  'playthrough.create': 'Playthrough created',
  'playthrough.select': 'Playthrough selected',
  'playthrough.setGameSetup': 'Playthrough Game Setup applied',
  'progress.create': 'Progress recorded',
  'progress.update': 'Progress updated',
  'quintarBreeding.toggleStep': 'Quintar breeding progress updated',
  'reference.mod-membership': 'Reference mod selection updated',
  'scenario.create': 'Party plan created',
  'scenario.update': 'Party plan updated',
  'scenario.replaceBuild': 'Party member Build changed',
  'team.create': 'Team created',
  'team.update': 'Team updated',
  'team.save': 'Team saved',
  'team.delete': 'Team deleted',
  'team.adopt': 'Team added to Tracking',
  'scenario.activate': 'Party plan selected',
  'progress.bulkSetStage': 'Class seal progress updated',
})

function actionLabel(command: string) {
  // Imported command names are unrestricted, so inherited object keys are never labels
  if (Object.hasOwn(HISTORY_ACTION_LABELS, command)) return HISTORY_ACTION_LABELS[command]
  // Unknown journal commands remain inspectable without exposing machine identifiers as titles
  return 'Change saved'
}

export function HistoryEntries({ changes }: { readonly changes: readonly ChangeEntry[] }) {
  return <>{changes.length ? <ol className="history-list">{[...changes].reverse().slice(0, HISTORY_VISIBLE_LIMIT).map(entry => <li className="history-entry" key={entry.id}><span className="history-entry__mark"><Icon name="history"/></span><div><strong>{actionLabel(entry.command)}</strong><time>{formatRelativeDate(entry.recordedAt)} · revision {entry.nextRevision}</time><details className="history-entry__details"><summary>Change details</summary><code>{entry.command}</code><ul>{entry.changedPaths.map(path => <li key={path}><code>{path}</code></li>)}</ul></details></div></li>)}</ol> : <InlineNotice title="No change history">Saved changes will appear here.</InlineNotice>}{changes.length > HISTORY_VISIBLE_LIMIT && <InlineNotice title="Earlier changes not shown">Export a backup to keep the complete retained history.</InlineNotice>}</>
}
