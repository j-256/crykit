export function catalogSnapshotKey(catalogId: string, catalogRevisionId: string): string {
  return JSON.stringify([catalogId, catalogRevisionId])
}
