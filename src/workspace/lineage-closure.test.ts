import { expect, it } from 'vitest'
import { createBlankLocalData, createPersonalDefinition } from '../domain/local-data'
import { personalLineageKey } from '../account/sync/lineage'
import { editorClosureFixture } from './test-helpers'
import { inspectWorkspaceClosure } from './closure'
import { blobIdentity } from './blobs'

it.each(['valid', 'selected-hash', 'selected-length', 'selected-encoding', 'wrapper-hash', 'wrapper-length', 'wrapper-encoding'])('personalLineageRequiresExactFullRefsAfterIndependentRehash %s', async variant => {
  const fixture = await editorClosureFixture()
  const data = createPersonalDefinition(createBlankLocalData(), { kind: 'item', name: 'Exact selected chain' })
  const definition = Object.values(data.personalDefinitions)[0], key = JSON.stringify(['personal-definition', definition.id])
  const root = await fixture.add(definition, 'native-root')
  const index = await fixture.add({ version: 1, kind: 'conflict-closure-page', entries: [{ version: 1, ref: root, documentVersion: 1, kind: 'personal-definition', key, encoding: 'json', dependencies: [] }], children: [] }, 'native-index')
  const changed = (ref: typeof root) => ({ ...ref, ...(variant.endsWith('hash') ? { sha256: '0'.repeat(64) } : {}), ...(variant.endsWith('length') ? { byteLength: ref.byteLength + 1 } : {}), ...(variant.endsWith('encoding') ? { encoding: 'bytes' as const } : {}) })
  const rootRef = { kind: 'personal' as const, definitionId: definition.id }, roots = [root, index]
  const relation = { kind: 'personal-lineage', privateKey: personalLineageKey(rootRef), rootRef, selected: variant.startsWith('selected') ? changed(root) : root, content: { version: 1, root, index } }
  const wrapper = await fixture.add({ version: 1, kind: 'unit-index', roots, relation }, 'wrapper')
  const wrapperIndex = await fixture.add({ version: 1, kind: 'conflict-closure-page', entries: [{ version: 1, ref: variant.startsWith('wrapper') ? changed(wrapper) : wrapper, documentVersion: 1, kind: 'unit-index', key: JSON.stringify(['unit-index', blobIdentity(wrapper)]), encoding: 'json', dependencies: roots }], children: [] }, 'wrapper-index')
  const inspected = inspectWorkspaceClosure({ ...fixture.state, blobs: fixture.blobs }, { version: 1, root: wrapper, index: wrapperIndex })
  if (variant === 'valid') expect((await inspected).value).toEqual(definition)
  else await expect(inspected).rejects.toThrow()
})
