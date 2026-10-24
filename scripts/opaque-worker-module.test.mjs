import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { prepareOpaqueWorkerModule } from './opaque-worker-module.mjs'

test('extracts only the reviewed release loader and preserves wrappers deterministically', async () => {
  const source = await readFile('node_modules/@serenity-kit/opaque/esm/index.js', 'utf8')
  const first = prepareOpaqueWorkerModule(source)
  const second = prepareOpaqueWorkerModule(source)
  assert.deepEqual(first, second)
  assert.equal(createHash('sha256').update(first.wasm).digest('hex'), '32255973125fe9ac1fdf54d7f152361b302299f4b6678a1cb1c9baa978f0d6db')
  assert.ok(first.javascript.startsWith("import opaqueWasm from './opaque.wasm'"))
  assert.ok(first.javascript.endsWith(source.slice(source.indexOf('/* @ts-self-types'))))
  assert.ok(!first.javascript.includes('WebAssembly.compile'))
  assert.throws(() => prepareOpaqueWorkerModule(source.replace('function wasmData', 'function otherData')), /Unreviewed OPAQUE/)
  assert.throws(() => prepareOpaqueWorkerModule(source + '\n'), /Unreviewed OPAQUE/)
})
