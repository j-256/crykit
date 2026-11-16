import { parse, type DefaultTreeAdapterTypes } from 'parse5'
import type { Plugin } from 'vite'

export const HOSTED_SHARE_SHELL = 'hosted-share.html'
export function hostedSharePlugin(): Plugin {
  return {
    name: 'crykit-hosted-share-shell',
    apply: 'build',
    generateBundle: { order: 'post', handler(_, bundle) {
      const index = bundle['index.html']
      if (index?.type !== 'asset' || typeof index.source !== 'string' || !index.source.includes('<head>')) throw new Error('Hosted shares require the built app shell')
      // Hosted paths belong to SERVICE_ORIGIN root; keep the ordinary relative-base shell portable
      const scripts: { startOffset: number; endOffset: number }[] = []
      const visit = (node: DefaultTreeAdapterTypes.Node) => {
        if ('tagName' in node && node.tagName === 'script' && node.attrs.some(attr => attr.name === 'data-cf-beacon') && node.sourceCodeLocation) scripts.push(node.sourceCodeLocation)
        if ('childNodes' in node) node.childNodes.forEach(visit)
      }
      visit(parse(index.source, { sourceCodeLocationInfo: true }))
      let source = index.source
      for (const script of scripts.sort((a, b) => b.startOffset - a.startOffset)) source = source.slice(0, script.startOffset) + source.slice(script.endOffset)
      // Public locators belong in HTTP paths, never third-party analytics; also block automatic injection
      source = source.replace('<head>', '<head>\n    <base href="/">\n    <meta http-equiv="Content-Security-Policy" content="script-src \'self\' \'wasm-unsafe-eval\'; connect-src \'self\'; worker-src \'self\' blob:">')
      this.emitFile({ type: 'asset', fileName: HOSTED_SHARE_SHELL, source })
    } },
  }
}
