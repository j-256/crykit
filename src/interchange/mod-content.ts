import { parseBoundedJson } from './json'
import { sha256 } from './util'
import { CRYSTAL_EDIT_JSON_LIMITS } from './crystal-edit-limits'

export const MOD_CONTENT_FINGERPRINT_VERSION = 'json-content-v1'

// Canonicalize the tokens rather than parsed numbers so distinct large integers cannot collide
// Objects are maps; arrays retain their order and every unknown source field participates
export function canonicalModJson(bytes: Uint8Array): string {
  parseBoundedJson(bytes, 'Mod JSON', CRYSTAL_EDIT_JSON_LIMITS)
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')
  let offset = 0
  const tokenPattern = /(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/y
  const whitespace = () => { while (/\s/.test(source[offset] ?? '') && offset < source.length) offset += 1 }
  const string = (): string => {
    const start = offset++
    while (source[offset] !== '"') { if (source[offset] === '\\') offset += 1; offset += 1 }
    offset += 1
    return JSON.parse(source.slice(start, offset)) as string
  }
  const value = (): string => {
    whitespace()
    if (source[offset] === '"') return JSON.stringify(string())
    if (source[offset] === '{') {
      offset += 1
      whitespace()
      const entries = new Map<string, string>()
      while (source[offset] !== '}') {
        const key = string()
        whitespace()
        offset += 1
        entries.set(key, value())
        whitespace()
        if (source[offset] === ',') { offset += 1; whitespace() } else break
      }
      offset += 1
      return `{${[...entries.keys()].sort().map(key => `${JSON.stringify(key)}:${entries.get(key)}`).join(',')}}`
    }
    if (source[offset] === '[') {
      offset += 1
      whitespace()
      const entries: string[] = []
      while (source[offset] !== ']') {
        entries.push(value())
        whitespace()
        if (source[offset] === ',') offset += 1
        else break
      }
      offset += 1
      return `[${entries.join(',')}]`
    }
    tokenPattern.lastIndex = offset
    const token = tokenPattern.exec(source)![0]
    offset += token.length
    if (!/^-?\d/.test(token)) return token
    const [mantissa, exponent = '0'] = token.toLowerCase().split('e')
    const fraction = mantissa!.split('.')[1]?.length ?? 0
    const negative = mantissa!.startsWith('-')
    let digits = mantissa!.replace(/[-.]/g, '').replace(/^0+/, '')
    if (!digits) return negative ? '-0e0' : '0e0'
    const trailing = /0*$/.exec(digits)![0].length
    digits = digits.slice(0, digits.length - trailing)
    return `${negative ? '-' : ''}${digits}e${BigInt(exponent) - BigInt(fraction) + BigInt(trailing)}`
  }
  return value()
}

export async function modContentFingerprint(bytes: Uint8Array): Promise<string> {
  return `${MOD_CONTENT_FINGERPRINT_VERSION}:sha256:${await sha256(new TextEncoder().encode(canonicalModJson(bytes)))}`
}
