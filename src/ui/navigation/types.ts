import { type InventoryPositionId, type CharacterId, type CharacterSnapshotId, type EntityRef, type BuildId, type BuildRevisionId, type ScenarioId, type TeamId, type ProgressRecordId } from '../../domain/types'

export type Destination = 'inventory' | 'characters' | 'builds' | 'teams' | 'progress' | 'reference' | 'mods' | 'map' | 'save-editor'

export type CharacterTab = 'current' | 'history'

export type SettingsSection = 'playthrough' | 'data' | 'game-setup' | 'history' | 'storage' | 'credits'

export type InventoryPageRoute =
  | { readonly page: 'inventory'; readonly view: 'list' }
  | { readonly page: 'inventory'; readonly view: 'new' }
  | { readonly page: 'inventory'; readonly view: 'event-new' }
  | { readonly page: 'inventory'; readonly view: 'edit'; readonly positionId: InventoryPositionId }

export type CharactersPageRoute =
  | { readonly page: 'characters'; readonly view: 'list' }
  | { readonly page: 'characters'; readonly view: 'new' }
  | { readonly page: 'characters'; readonly view: 'character'; readonly characterId: CharacterId; readonly tab: CharacterTab }
  | { readonly page: 'characters'; readonly view: 'snapshot-new'; readonly characterId: CharacterId }
  | { readonly page: 'characters'; readonly view: 'snapshot'; readonly characterId: CharacterId; readonly snapshotId: CharacterSnapshotId }
  | { readonly page: 'characters'; readonly view: 'snapshot-compare'; readonly characterId: CharacterId }
  | { readonly page: 'characters'; readonly view: 'snapshot-pair'; readonly characterId: CharacterId; readonly leftSnapshotId: CharacterSnapshotId; readonly rightSnapshotId: CharacterSnapshotId }
  | { readonly page: 'characters'; readonly view: 'skill-screenshots'; readonly characterId: CharacterId }
  | { readonly page: 'characters'; readonly view: 'class-new'; readonly characterId: CharacterId }
  | { readonly page: 'characters'; readonly view: 'class-edit'; readonly characterId: CharacterId; readonly ref: EntityRef }
  | { readonly page: 'characters'; readonly view: 'learning-new'; readonly characterId: CharacterId; readonly learningKind: 'knowledge' | 'magic' }
  | { readonly page: 'characters'; readonly view: 'learning-edit'; readonly characterId: CharacterId; readonly learningKind: 'knowledge' | 'magic'; readonly ref: EntityRef }

export type BuildsPageRoute =
  | { readonly page: 'builds'; readonly view: 'library' }
  | { readonly page: 'builds'; readonly view: 'build-new' }
  | { readonly page: 'builds'; readonly view: 'build'; readonly buildId: BuildId }
  | { readonly page: 'builds'; readonly view: 'revision-new'; readonly buildId: BuildId }
  | { readonly page: 'builds'; readonly view: 'revision'; readonly buildId: BuildId; readonly revisionId: BuildRevisionId }
  | { readonly page: 'builds'; readonly view: 'revision-edit'; readonly buildId: BuildId; readonly revisionId: BuildRevisionId; readonly baseRevisionId?: BuildRevisionId }
  | { readonly page: 'builds'; readonly view: 'record-current'; readonly buildId: BuildId; readonly revisionId: BuildRevisionId }
  | { readonly page: 'builds'; readonly view: 'teams' }
  | { readonly page: 'builds'; readonly view: 'scenario-new' }
  | { readonly page: 'builds'; readonly view: 'scenario'; readonly scenarioId: ScenarioId }
  | { readonly page: 'builds'; readonly view: 'compare' }
  | { readonly page: 'builds'; readonly view: 'compare-pair'; readonly leftRevisionId: BuildRevisionId; readonly rightRevisionId: BuildRevisionId }

export type TeamsPageRoute =
  | { readonly page: 'teams'; readonly view: 'list' }
  | { readonly page: 'teams'; readonly view: 'new' }
  | { readonly page: 'teams'; readonly view: 'team' | 'edit' | 'adopt'; readonly teamId: TeamId }

export type ProgressPageRoute =
  | { readonly page: 'progress'; readonly view: 'list' }
  | { readonly page: 'progress'; readonly view: 'unlocks' }
  | { readonly page: 'progress'; readonly view: 'summons' }
  | { readonly page: 'progress'; readonly view: 'quintar' }
  | { readonly page: 'progress'; readonly view: 'new' }
  | { readonly page: 'progress'; readonly view: 'edit'; readonly recordId: ProgressRecordId }

export const PROGRESS_PAGES = [
  { label: 'Class seals', segment: 'seals', page: { page: 'progress', view: 'list' } },
  { label: 'Travel & unlocks', segment: 'unlocks', page: { page: 'progress', view: 'unlocks' } },
  { label: 'Summons', segment: 'summons', page: { page: 'progress', view: 'summons' } },
  { label: 'Quintar breeding', segment: 'quintar', page: { page: 'progress', view: 'quintar' } },
] as const satisfies readonly { readonly label: string; readonly segment: string; readonly page: ProgressPageRoute }[]

export type ReferencePageRoute =
  | { readonly page: 'reference'; readonly view: 'list' }
  | { readonly page: 'reference'; readonly view: 'detail'; readonly ref: EntityRef }
  | { readonly page: 'reference'; readonly view: 'promote' }

export type SettingsPageRoute =
  | { readonly page: 'settings'; readonly section: SettingsSection }
  | { readonly page: 'settings'; readonly section: 'data'; readonly previewId: string }

export interface UnresolvedPageRoute {
  readonly page: 'unresolved'
  readonly requestedPath: string
  readonly reason: 'unknown-route' | 'malformed-identifier' | 'malformed-entity-reference'
  readonly recovery: Destination
}

export type PageRoute = InventoryPageRoute | CharactersPageRoute | BuildsPageRoute | TeamsPageRoute | ProgressPageRoute | ReferencePageRoute | SettingsPageRoute | UnresolvedPageRoute | { readonly page: 'share'; readonly encoded: string } | { readonly page: 'mods'; readonly view: 'library' | 'editor' } | { readonly page: 'map' } | { readonly page: 'save-editor' }

export interface SearchOverlay {
  readonly kind: 'search'
  readonly query: string
}

export interface DefinitionPickerOverlay {
  readonly kind: 'definition-picker'
  readonly fieldKey: string
  readonly query: string
  readonly resultLimit: number
}

export type DefinitionEditorOverlay =
  | { readonly kind: 'definition-editor'; readonly mode: 'new' }
  | { readonly kind: 'definition-editor'; readonly mode: 'override'; readonly ref: EntityRef }

export type RouteOverlay = SearchOverlay | DefinitionPickerOverlay | DefinitionEditorOverlay

export type RouteQuery = Readonly<Record<string, readonly string[]>>

export interface AppRoute {
  readonly page: PageRoute
  readonly overlays: readonly RouteOverlay[]
  readonly query: RouteQuery
  readonly legacy?: true
}

export const BUILDS_ROUTE: AppRoute = Object.freeze({ page: { page: 'builds' as const, view: 'library' as const }, overlays: [], query: {} })
