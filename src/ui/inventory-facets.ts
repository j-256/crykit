import { referenceCategoryLabel } from './reference-categories'

export interface CategoryFacetGroup {
  readonly value: string
  readonly label: string
  readonly count: number
}

export function groupCategoryFacetValues(records: readonly (readonly string[])[]): readonly CategoryFacetGroup[] {
  const counts = new Map<string, number>()
  for (const record of records) {
    for (const key of new Set(record)) {
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return [...counts].map(([value, count]) => ({ value, label: referenceCategoryLabel(value), count }))
    .sort((left, right) => left.label.localeCompare(right.label))
}
