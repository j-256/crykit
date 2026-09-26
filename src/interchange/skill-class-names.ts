const MIN_APPROXIMATE_CLASS_NAME_LENGTH = 4
const MAX_CLASS_NAME_CHARACTER_ERRORS = 1

export type ScreenshotClassNameMatch<Choice> =
  | { readonly kind: 'exact' | 'normalized' | 'approximate'; readonly choice: Choice }
  | { readonly kind: 'ambiguous' | 'unrecognized' }

function normalizeClassName(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/gu, '')
}

function withinCharacterErrorLimit(left: string, right: string): boolean {
  if (Math.abs(left.length - right.length) > MAX_CLASS_NAME_CHARACTER_ERRORS) return false
  let leftIndex = 0
  let rightIndex = 0
  let errors = 0
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      leftIndex++
      rightIndex++
      continue
    }
    if (++errors > MAX_CLASS_NAME_CHARACTER_ERRORS) return false
    if (left.length >= right.length) leftIndex++
    if (right.length >= left.length) rightIndex++
  }
  return errors + left.length - leftIndex + right.length - rightIndex <= MAX_CLASS_NAME_CHARACTER_ERRORS
}

export function matchScreenshotClassName<Choice extends { readonly name: string }>(choices: readonly Choice[], text?: string): ScreenshotClassNameMatch<Choice> {
  const name = normalizeClassName(text ?? '')
  if (!name) return { kind: 'unrecognized' }
  const normalized = choices.map(choice => ({ choice, name: normalizeClassName(choice.name) }))
  const exact = normalized.filter(candidate => candidate.name === name)
  if (exact.length > 1) return { kind: 'ambiguous' }
  if (exact.length === 1) {
    const choice = exact[0].choice
    return { kind: choice.name.toLowerCase() === text?.trim().toLowerCase() ? 'exact' : 'normalized', choice }
  }
  if (name.length < MIN_APPROXIMATE_CLASS_NAME_LENGTH) return { kind: 'unrecognized' }
  const close = normalized.filter(candidate => candidate.name.length >= MIN_APPROXIMATE_CLASS_NAME_LENGTH && withinCharacterErrorLimit(name, candidate.name))
  if (close.length > 1) return { kind: 'ambiguous' }
  return close.length === 1 ? { kind: 'approximate', choice: close[0].choice } : { kind: 'unrecognized' }
}
