export interface DraftActions {
  readonly save: () => Promise<boolean>
  readonly discard: () => void | boolean | Promise<void | boolean>
}

export type DraftChangeHandler = (dirty: boolean, actions?: DraftActions) => void
