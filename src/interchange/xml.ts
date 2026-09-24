import { AppDataError } from './errors'

const XML_FORBIDDEN_DECLARATION = /<!\s*(?:DOCTYPE|ENTITY)\b/i

export function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new AppDataError('invalid-xml', `${label} is not valid UTF-8`, {
      recoverable: true,
      cause: error,
    })
  }
}

export function parseXml(bytes: Uint8Array, label: string, expectedRoot?: string): XMLDocument {
  const source = decodeUtf8(bytes, label)
  if (XML_FORBIDDEN_DECLARATION.test(source)) {
    throw new AppDataError('invalid-xml', `${label} contains a forbidden XML declaration`, {
      recoverable: true,
    })
  }
  const document = new DOMParser().parseFromString(source, 'application/xml')
  if (document.getElementsByTagName('parsererror').length > 0) {
    throw new AppDataError('invalid-xml', `${label} is malformed XML`, { recoverable: true })
  }
  if (expectedRoot && document.documentElement.localName !== expectedRoot) {
    throw new AppDataError('invalid-xml', `${label} has an unexpected root element`, {
      recoverable: true,
      details: { expected: expectedRoot, actual: document.documentElement.localName },
    })
  }
  return document
}

export function elements(parent: ParentNode, namespace: string, localName: string): readonly Element[] {
  return Array.from((parent as Document | Element).getElementsByTagNameNS(namespace, localName))
}

export function firstElement(parent: ParentNode, namespace: string, localName: string): Element | undefined {
  return elements(parent, namespace, localName)[0]
}

export function relationshipPartPath(part: string): string {
  const separator = part.lastIndexOf('/')
  const directory = separator < 0 ? '' : part.slice(0, separator + 1)
  const filename = separator < 0 ? part : part.slice(separator + 1)
  return `${directory}_rels/${filename}.rels`
}

export function resolvePackageTarget(basePart: string, target: string): string {
  if (
    target.length === 0 ||
    target.includes('\0') ||
    target.includes('\\') ||
    target.includes('?') ||
    target.includes('#') ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)
  ) {
    throw new AppDataError('unsafe-archive', 'An OOXML relationship has an unsafe target', {
      recoverable: true,
      details: { target },
    })
  }
  const baseSegments = target.startsWith('/')
    ? []
    : basePart.slice(0, Math.max(0, basePart.lastIndexOf('/'))).split('/').filter(Boolean)
  for (const segment of target.replace(/^\/+/, '').split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (baseSegments.length === 0) {
        throw new AppDataError('unsafe-archive', 'An OOXML relationship escapes the package root', {
          recoverable: true,
          details: { target },
        })
      }
      baseSegments.pop()
      continue
    }
    if (segment.includes('\0')) {
      throw new AppDataError('unsafe-archive', 'An OOXML relationship has an unsafe target', {
        recoverable: true,
        details: { target },
      })
    }
    baseSegments.push(segment)
  }
  if (baseSegments.length === 0) {
    throw new AppDataError('unsafe-archive', 'An OOXML relationship resolved to the package root', {
      recoverable: true,
      details: { target },
    })
  }
  return baseSegments.join('/')
}
