export const MAX_IMPORT_BYTES = 96 * 1024 * 1024

export async function readModFile(file: Pick<File, 'size' | 'arrayBuffer'>): Promise<string> {
  if (file.size > MAX_IMPORT_BYTES) throw new Error('Mod exceeds the 96 MiB import size limit. Split the mod into smaller documents before importing.')
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer())
  } catch (error) {
    if (error instanceof TypeError) throw new Error('Mod is not valid UTF-8. Save the source JSON as UTF-8 before importing.')
    throw error
  }
}
