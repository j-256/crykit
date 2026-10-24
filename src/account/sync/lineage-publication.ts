import { z } from 'zod'
import { OpaqueIdSchema } from '../protocol'
import type { ProfileToken } from '../profile'
import type { AccountDatabase, CipherRef } from '../../persistence/account-database'
import { CipherRefSchema, accountLocalId, cipherRef, openAccountJson } from '../../workspace/account-cache'
import type { OpenAccountWorkspace } from '../../workspace/account-graph'
import { NativeLocalDataSchema } from '../../interchange/native-schema'
import { definitionLineageRootRef } from '../../domain/definitions'
import { createBlankLocalData } from '../../domain/local-data'
import type { EntityRef, PersonalDefinition } from '../../domain/types'
import { sameCipherRefs } from '../../workspace/account-retaining'
import { personalLineageChains, personalLineageKey } from './lineage'
import { publicationPageSchema, stagePublicationPages, stagePublicationJson } from './publication'
import { readPublicationPages } from './projection'
import { SyncError } from './client'

const DefinitionSchema = NativeLocalDataSchema.shape.personalDefinitions.valueType
export const LineageEntrySchema = z.strictObject({ key: z.string(), ref: CipherRefSchema, digest: z.string().regex(/^[a-f0-9]{64}$/) })
export const LineagePageSchema = publicationPageSchema(LineageEntrySchema, 'publication-lineage-page')
export const PublicationLineageSchema = z.strictObject({ version: z.literal(1), kind: z.literal('publication-lineage'), privateKey: z.string(), lineageId: OpaqueIdSchema, root: DefinitionSchema.shape.baseRef.unwrap(), selected: CipherRefSchema, chain: CipherRefSchema, deleted: z.literal(true).optional(), reallocatedFrom: CipherRefSchema.optional() })
export interface PersonalLineagePublication { readonly ref: CipherRef; readonly value: z.infer<typeof PublicationLineageSchema>; readonly entries: readonly z.infer<typeof LineageEntrySchema>[] }
export function isPersonalLineageKey(key: string): boolean {
  try { const parsed: unknown = JSON.parse(key); return Array.isArray(parsed) && parsed.length === 2 && parsed[0] === 'personal-lineage' && typeof parsed[1] === 'string' }
  catch { return false }
}
export async function stagePersonalLineage(database: AccountDatabase, token: ProfileToken, workspace: OpenAccountWorkspace, privateKey: string, lineageId: string, previous?: CipherRef | readonly CipherRef[], allocation?: string, reallocatedFrom?: CipherRef): Promise<PersonalLineagePublication> {
  const definitions = personalLineageChains(workspace.state.planner.localData).get(privateKey)
  if (!definitions?.length) throw new SyncError('INTEGRITY_FAILED')
  const entries = definitions.map(definition => {
    const entry = workspace.entries.find(entry => entry.key === JSON.stringify(['personal-definition', definition.id]))
    if (!entry || entry.kind !== 'personal-definition') throw new SyncError('INTEGRITY_FAILED')
    return { key: entry.key, ref: entry.ref, digest: entry.digest }
  })
  const root = definitionLineageRootRef(workspace.state.planner.localData, { kind: 'personal', definitionId: definitions[0].id })
  const chain = await stagePublicationPages(database, token, 'publication-lineage-page', entries, entry => [entry.ref])
  const value = PublicationLineageSchema.parse({ version: 1, kind: 'publication-lineage', privateKey, lineageId, root, selected: entries.at(-1)!.ref, chain, ...(reallocatedFrom ? { reallocatedFrom } : {}) })
  const parents = previous ? Array.isArray(previous) ? previous : [previous as CipherRef] : []
  const documentId = parents[0]?.documentId ?? allocation ?? accountLocalId()
  const ref = cipherRef(await stagePublicationJson(database, token, value, [chain, ...(reallocatedFrom ? [reallocatedFrom] : [])], documentId, previous))
  return { ref, value, entries }
}
export async function readPersonalLineage(database: AccountDatabase, token: ProfileToken, ref: CipherRef, read: OpenAccountWorkspace['readCaptured']): Promise<PersonalLineagePublication> {
  const value = await openAccountJson(database, token, ref, PublicationLineageSchema)
  const descriptor = await database.encryptedRevisions.get(ref.revisionId)
  if (!descriptor || !sameCipherRefs(descriptor.descriptor.dependencies, [value.chain, ...(value.reallocatedFrom ? [value.reallocatedFrom] : [])])) throw new SyncError('INTEGRITY_FAILED')
  const entries = await readPublicationPages(database, token, value.chain, LineagePageSchema, entry => [entry.ref])
  if (!entries.length || !sameCipherRefs([entries.at(-1)!.ref], [value.selected]) || new Set(entries.map(entry => entry.key)).size !== entries.length) throw new SyncError('INTEGRITY_FAILED')
  const definitions: Record<string, PersonalDefinition> = {}
  for (const entry of entries) {
    const body = await read(entry.ref)
    const definition = DefinitionSchema.parse(body.document.value) as unknown as PersonalDefinition
    if (body.document.kind !== 'personal-definition' || body.document.key !== entry.key || entry.key !== JSON.stringify(['personal-definition', definition.id]) || body.digest !== entry.digest) throw new SyncError('INTEGRITY_FAILED')
    definitions[definition.id] = definition
  }
  const data = { ...createBlankLocalData(), personalDefinitions: definitions }, chains = personalLineageChains(data)
  const expected = chains.get(value.privateKey)
  if (chains.size !== 1 || !expected || personalLineageKey(value.root as EntityRef) !== value.privateKey || JSON.stringify(expected.map(definition => JSON.stringify(['personal-definition', definition.id]))) !== JSON.stringify(entries.map(entry => entry.key))) throw new SyncError('INTEGRITY_FAILED')
  const root = definitionLineageRootRef(data, { kind: 'personal', definitionId: expected[0].id })
  if (personalLineageKey(root) !== value.privateKey) throw new SyncError('INTEGRITY_FAILED')
  if (value.reallocatedFrom) {
    if (value.reallocatedFrom.documentId === ref.documentId || descriptor.descriptor.parents.length) throw new SyncError('INTEGRITY_FAILED')
    const original = await openAccountJson(database, token, value.reallocatedFrom, PublicationLineageSchema)
    const source = await database.encryptedRevisions.get(value.reallocatedFrom.revisionId)
    if (original.reallocatedFrom || original.deleted || !source || source.descriptor.documentId !== value.reallocatedFrom.documentId || source.descriptor.parents.length || original.privateKey !== value.privateKey || original.lineageId !== value.lineageId || !sameCipherRefs([original.selected], [value.selected])) throw new SyncError('INTEGRITY_FAILED')
    const old = await readPersonalLineage(database, token, value.reallocatedFrom, read)
    if (JSON.stringify(old.entries) !== JSON.stringify(entries)) throw new SyncError('INTEGRITY_FAILED')
  }
  return { ref, value, entries }
}

export async function stageDeletedPersonalLineage(database: AccountDatabase, token: ProfileToken, previous: PersonalLineagePublication, lineageId: string): Promise<PersonalLineagePublication> {
  // Deletion preserves the complete original chain as evidence while removing its active selection
  const { reallocatedFrom: _source, ...prior } = previous.value
  const value = PublicationLineageSchema.parse({ ...prior, lineageId, deleted: true })
  const ref = cipherRef(await stagePublicationJson(database, token, value, [value.chain], previous.ref.documentId, previous.ref))
  return { ...previous, ref, value }
}
