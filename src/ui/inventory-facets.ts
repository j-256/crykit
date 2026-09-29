export interface CategoryFacetGroup {
  readonly value: string
  readonly count: number
  readonly members: readonly string[]
}

function normalizeCategory(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
}

function categoryGroupKey(value: string, values: ReadonlySet<string>): string {
  const normalized = normalizeCategory(value)
  if (normalized.endsWith('s') && values.has(normalized.slice(0, -1))) return normalized.slice(0, -1)
  if (values.has(`${normalized}s`)) return normalized
  return normalized
}

function categoryGroupLabel(key: string, members: readonly string[]): string {
  if (members.length === 1) return members[0]!
  const normalized = members.map(normalizeCategory)
  const plural = normalized.find((value) => value.endsWith('s') && value.slice(0, -1) === key)
  const label = plural ?? key
  return label.charAt(0).toLocaleUpperCase() + label.slice(1)
}

export function groupCategoryFacetValues(records: readonly (readonly string[])[]): readonly CategoryFacetGroup[] {
  const rawValues = [...new Set(records.flatMap((record) => record.map((value) => value.trim().replace(/\s+/g, ' ')).filter(Boolean)))]
  const normalizedValues = new Set(rawValues.map(normalizeCategory))
  const grouped = new Map<string, { members: Set<string>; records: Set<number> }>()
  records.forEach((record, recordIndex) => {
    const recordKeys = new Set<string>()
    for (const rawValue of record) {
      const value = rawValue.trim().replace(/\s+/g, ' ')
      if (!value) continue
      const key = categoryGroupKey(value, normalizedValues)
      const group = grouped.get(key) ?? { members: new Set<string>(), records: new Set<number>() }
      group.members.add(value)
      grouped.set(key, group)
      recordKeys.add(key)
    }
    for (const key of recordKeys) grouped.get(key)?.records.add(recordIndex)
  })
  return [...grouped].map(([key, group]) => {
    const members = [...group.members].sort((left, right) => left.localeCompare(right))
    return { value: categoryGroupLabel(key, members), count: group.records.size, members }
  }).sort((left, right) => left.value.localeCompare(right.value))
}

export function selectedCategoryFacetValues(groups: readonly CategoryFacetGroup[], selected: readonly string[]): readonly string[] {
  return [...new Set(selected.map((value) => groups.find((group) => group.value === value || group.members.includes(value))?.value ?? value))]
}

export function expandCategoryFacetValues(groups: readonly CategoryFacetGroup[], selected: readonly string[]): readonly string[] {
  return [...new Set(selected.flatMap((value) => groups.find((group) => group.value === value || group.members.includes(value))?.members ?? [value]))]
}
