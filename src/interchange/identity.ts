export function catalogSnapshotKey(catalogId: string, catalogRevisionId: string): string {
  return JSON.stringify([catalogId, catalogRevisionId])
}

// Membership hashes bind an already validated ordered set; they never grant mutation authority
export async function inheritedSnapshotSetDigest(sortedUniqueIds: Iterable<string>): Promise<string> {
  const { hashBlob } = await import('../workspace/blobs')
  const encoder = new TextEncoder(), prefix = encoder.encode('crykit/inherited-snapshot-set/v1\0')
  const ids: string[] = []
  let previous = ''
  for (const id of sortedUniqueIds) {
    if (!/^[0-9a-f]{64}$/.test(id) || id <= previous) throw new Error('Invalid inherited snapshot membership')
    ids.push(id); previous = id
  }
  return hashBlob({ byteLength: prefix.length + ids.length * 64, async *open() { yield prefix; for (const id of ids) yield encoder.encode(id) } })
}
