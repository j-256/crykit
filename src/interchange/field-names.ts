export function normalizeImportedFieldName(field: string): string {
  return (field.split('.').at(-1) ?? field)
    .trim()
    .toLocaleLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
}
