import { DomainError, assertTextLength } from './core'
import { MAX_COLLECTION_LENGTH, MAX_SHORT_TEXT_LENGTH } from './limits'

export function normalizeBuildTags(tags: readonly string[]): readonly string[] {
  if (tags.length > MAX_COLLECTION_LENGTH) {
    throw new DomainError('INVALID_INPUT', `Build tags must contain at most ${MAX_COLLECTION_LENGTH} values`)
  }
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of tags) {
    const tag = value.trim()
    if (!tag) continue
    assertTextLength(tag, 'Build tag', MAX_SHORT_TEXT_LENGTH)
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(tag)
  }
  return result
}
