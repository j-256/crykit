import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import type { Plugin } from 'vite'

const require = createRequire(import.meta.url)

export function ocrAssets(): Plugin {
  const assets = new Map<string, string>([
    ['ocr/worker.min.js', join(dirname(require.resolve('tesseract.js/package.json')), 'dist/worker.min.js')],
    ['ocr/eng.traineddata.gz', join(dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int/eng.traineddata.gz')],
    ['ocr/tesseract-license.txt', join(dirname(require.resolve('tesseract.js/package.json')), 'LICENSE.md')],
    ['ocr/core-license.txt', join(dirname(require.resolve('tesseract.js-core/package.json')), 'LICENSE')],
  ])
  // Each wrapper embeds its complete WASM payload; separate binaries only duplicate the download
  // Keep every SIMD fallback available because the worker chooses according to browser support
  for (const variant of ['lstm', 'simd-lstm', 'relaxedsimd-lstm']) {
    const name = `tesseract-core-${variant}.wasm.js`
    assets.set(`ocr/${name}`, join(dirname(require.resolve('tesseract.js-core/package.json')), name))
  }
  return {
    name: 'local-ocr-assets',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split('?')[0]?.replace(/^\//, '') ?? ''
        const source = assets.get(path)
        if (!source) return next()
        response.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream')
        response.end(readFileSync(source))
      })
    },
    generateBundle() {
      for (const [fileName, source] of assets) this.emitFile({ type: 'asset', fileName, source: readFileSync(source) })
    },
  }
}
