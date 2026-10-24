const CONTROL = /[\u0000-\u001f\u007f]/
const ENCODED_COMPONENT = /%[0-9a-f]{2}/i

export function normalizeProjectPath(path: string): string {
  // The original path stays private; only safe normalized components may govern selection or matching
  if (!path || CONTROL.test(path) || path.startsWith('/') || path.startsWith('\\') || /^[a-z][a-z\d+.-]*:/i.test(path) || ENCODED_COMPONENT.test(path)) throw new Error('Unsafe or ambiguous relative path')
  const normalized = path.replaceAll('\\', '/').normalize('NFC')
  if (normalized.split('/').some(component => !component || component === '.' || component === '..' || CONTROL.test(component))) throw new Error('Unsafe or ambiguous relative path')
  return normalized
}
