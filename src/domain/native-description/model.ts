export interface NativeDescription {
  readonly lines: readonly string[]
  readonly complete: boolean
  readonly unresolved: readonly string[]
}

export const MAX_TEXT_LENGTH = 16_384

export const MAX_REFERENCE_DEPTH = 4

export const PERCENT = 100

export const ATTRIBUTES = Object.freeze({ HP: 'HP', MP: 'MP', AP: 'AP' })
