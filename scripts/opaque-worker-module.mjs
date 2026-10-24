import { createHash } from 'node:crypto'

const reviewedSourceSha256 = '1e8d56383a77948e453085b6d4f52dcb9645f8bfff32395738b63d3a2e2fcb52'
export function prepareOpaqueWorkerModule(source) {
  // Workerd requires collected WASM; a dependency upgrade must review this exact packaging seam
  if (createHash('sha256').update(source).digest('hex') !== reviewedSourceSha256) throw new Error('Unreviewed OPAQUE release source')
  const marker = source.indexOf('/* @ts-self-types')
  const embedded = source.slice(0, marker).match(/function wasmData\(imports\)\{return _loadWasmModule\(0, null, '([A-Za-z0-9+/=]+)'\)\}/)
  if (!embedded || marker < 0) throw new Error('Unreviewed OPAQUE loader')
  // Everything after the release loader, including initialization and wasm-bindgen wrappers, is verbatim
  return { wasm: Buffer.from(embedded[1], 'base64'), javascript: "import opaqueWasm from './opaque.wasm'\nfunction wasmData() { return opaqueWasm }\n\n" + source.slice(marker) }
}
