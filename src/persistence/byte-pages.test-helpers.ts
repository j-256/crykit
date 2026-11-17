import { Buffer } from 'node:buffer'

export function assertBytePagesEqual(actual: readonly Uint8Array[], expected: readonly Uint8Array[]): void {
  if (actual.length !== expected.length) throw new Error(`Byte page count: ${actual.length} !== ${expected.length}`)
  for (let page = 0; page < actual.length; page++) {
    const left = actual[page], right = expected[page]
    if (left.byteLength !== right.byteLength) throw new Error(`Byte page ${page} length: ${left.byteLength} !== ${right.byteLength}`)
    // Generic deep equality enumerates every typed-array entry and allocates large object graphs
    // Compare the exact view bytes without copying; page boundaries remain part of the assertion
    const leftView = Buffer.from(left.buffer, left.byteOffset, left.byteLength)
    const rightView = Buffer.from(right.buffer, right.byteOffset, right.byteLength)
    if (leftView.equals(rightView)) continue
    // Locate only the first difference on failure instead of formatting an entire private stream
    let offset = 0
    while (left[offset] === right[offset]) offset++
    throw new Error(`Byte page ${page} offset ${offset}: ${left[offset]} !== ${right[offset]}`)
  }
}
