export interface DraftActions {
  readonly save: () => Promise<boolean>
  readonly discard: () => void
}

export type DraftChangeHandler = (dirty: boolean, actions?: DraftActions) => void
