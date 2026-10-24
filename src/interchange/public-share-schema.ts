import { z } from 'zod'

// This module is also the Worker admission boundary; never import private graph or game-data modules
export const PUBLIC_SHARE_LIMITS = Object.freeze({ bytes: 256 * 1024, depth: 32, nodes: 20_000, id: 1024, display: 256, notes: 16_384, receipts: 1024, entries: 64, inputs: 128, url: 64 * 1024 })
export const PUBLIC_SHARE_ROUTE_PREFIX = '#/share/v5/'
const id = z.string().min(1).max(PUBLIC_SHARE_LIMITS.id).refine(value => !/[\u0000-\u001f\u007f/\\]/.test(value) && !/\.(json|png|jpe?g|webp|zip|xlsx|sav)(?:$|[?#])/i.test(value), 'Public identities cannot contain paths or filenames')
const display = z.string().min(1).max(PUBLIC_SHARE_LIMITS.display)
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const contentDigest = z.string().regex(/^[a-f0-9]{64}$/)
const fingerprint = z.object({ kind: z.enum(['json-content-v1', 'personal-definition-v1']), value: contentDigest }).strict()
const pin = z.object({ catalogId: id, catalogRevisionId: id }).strict()
export const PublicRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('catalog'), catalogId: id, catalogRevisionId: id, entityId: id }).strict(),
  z.object({ kind: z.literal('personal'), fingerprint: z.object({ kind: z.literal('personal-definition-v1'), value: contentDigest }).strict() }).strict(),
])
const ref = PublicRefSchema
const refs = z.array(ref).max(PUBLIC_SHARE_LIMITS.inputs)
// Match the native signed integer and PC level bounds without pulling bundled game data into the Worker
const nativeInteger = z.number().int().min(0).max(0x7fffffff)
const quantity = nativeInteger.nullable()
const resources = z.object({ hp: quantity, mp: quantity, ap: quantity }).strict()
const statuses = z.array(z.object({ ref, count: nativeInteger.min(1).nullable() }).strict()).max(PUBLIC_SHARE_LIMITS.inputs)
const battle = z.object({ version: z.literal(1), turnCount: quantity, targetTurnCount: quantity, automaticStatuses: z.boolean(), statuses, user: resources, target: z.union([z.literal('self'), ref]).nullable(), targetResources: resources, targetStatuses: statuses, repeatCount: quantity, bottomThreat: z.boolean().nullable(), topThreat: z.boolean().nullable(), targetIsThreatTarget: z.boolean().nullable(), targetCharging: z.boolean().nullable(), previouslyAppliedStatuses: refs, userPreviouslyAppliedStatuses: refs }).strict()
export const PublicCalculationSchema = z.object({
  model: z.literal('pc-1.6.9-v1').optional(), growthMode: z.enum(['primary', 'manual']).optional(), pcMode: z.enum(['standard', 'vanilla', 'chaos']).optional(), gender: z.enum(['male', 'female']).optional(), genderSelection: z.object({ version: z.literal(1), id: nativeInteger }).strict().optional(),
  level: z.number().int().min(1).max(60).nullable(), growth: z.array(z.object({ classRef: ref.nullable(), levels: z.number().int().min(0).max(60).nullable() }).strict()).max(PUBLIC_SHARE_LIMITS.inputs), bonuses: z.array(z.enum(['HP', 'MP', 'STR', 'VIT', 'DEX', 'AGI', 'MND', 'SPI', 'SPD', 'LUK'])).max(10).refine(values => new Set(values).size === values.length), statuses: refs, ability: ref.nullable().optional(), targetEvasion: z.number().finite().min(0).max(0x7fffffff).nullable().optional(), battle: battle.optional(),
}).strict().refine(value => value.gender === undefined || value.genderSelection === undefined, 'Choose one gender input')
const knowledge = <T extends z.ZodType>(value: T) => z.union([z.object({ state: z.literal('known'), value }).strict(), z.object({ state: z.enum(['unknown', 'conflicting', 'notApplicable']) }).strict()])
const source = pin.extend({ title: display, checksum: digest.optional(), contentFingerprint: z.string().regex(/^json-content-v1:sha256:[a-f0-9]{64}$/).optional() }).strict()
export const PublicSetupSchema = z.object({ catalogLock: z.record(id, id).refine(value => Object.keys(value).length <= PUBLIC_SHARE_LIMITS.entries).optional(), baseline: pin.nullable(), layers: z.array(source).max(PUBLIC_SHARE_LIMITS.entries), mode: knowledge(display), difficulty: knowledge(nativeInteger).optional(), ppLimit: knowledge(nativeInteger).optional(), ppCostsNonNegative: knowledge(z.boolean()), slots: z.array(z.object({ id, label: display, equipmentRole: z.enum(['mainHand', 'offHand', 'head', 'body', 'accessory']).nullable().optional() }).strict()).max(PUBLIC_SHARE_LIMITS.entries) }).strict()
export const PublicEntityReceiptSchema = z.object({ ref, kind: z.enum(['item', 'class', 'ability', 'passive', 'innate', 'monsterMagic', 'monster', 'command', 'status', 'recipe', 'location', 'other']), name: display, fingerprint: fingerprint.optional(), origin: z.object({ kind: z.enum(['catalog', 'personal']), projectId: id, sourceRevisionId: id, catalogId: id, catalogRevisionId: id, modelKey: id.optional() }).strict() }).strict()
// Member names are explicit public Team metadata; no source Build metadata follows this field
export const PublicLoadoutSchema = z.object({ name: z.string().min(1).max(PUBLIC_SHARE_LIMITS.id).optional(), primaryClass: ref.nullable(), secondaryClass: ref.nullable(), equipment: z.array(z.object({ slotId: id, ref: ref.nullable() }).strict()).max(PUBLIC_SHARE_LIMITS.entries), equipmentGroups: z.array(z.array(id).min(2).max(PUBLIC_SHARE_LIMITS.entries)).max(PUBLIC_SHARE_LIMITS.entries), passives: z.array(ref).max(PUBLIC_SHARE_LIMITS.entries), calculation: PublicCalculationSchema.optional() }).strict()
const note = z.string().max(PUBLIC_SHARE_LIMITS.notes)
export const PublicNotesSchema = z.object({ checkpoint: note.optional(), slots: z.array(z.object({ rotationNotes: note.optional(), contextAssumptions: z.array(note).max(PUBLIC_SHARE_LIMITS.entries), checkpoint: note.optional() }).strict().nullable()).max(4) }).strict()
export const PublicSnapshotSchema = z.object({ version: z.literal(5), kind: z.enum(['build', 'team']), title: z.string().min(1).max(PUBLIC_SHARE_LIMITS.id), setup: PublicSetupSchema, slots: z.array(PublicLoadoutSchema.nullable()).min(1).max(4), receipts: z.array(PublicEntityReceiptSchema).max(PUBLIC_SHARE_LIMITS.receipts), notes: PublicNotesSchema.optional() }).strict()
export type PublicSnapshot = z.infer<typeof PublicSnapshotSchema>
export type PublicSetup = z.infer<typeof PublicSetupSchema>
export type PublicLoadout = z.infer<typeof PublicLoadoutSchema>
export type PublicEntityReceipt = z.infer<typeof PublicEntityReceiptSchema>
export type PublicNotes = z.infer<typeof PublicNotesSchema>
export type PublicRef = z.infer<typeof PublicRefSchema>
export function publicRefKey(value: PublicRef): string { return JSON.stringify(value) }

function bounded(value: unknown): void {
  let nodes = 0
  let textBytes = 0
  const visit = (child: unknown, depth: number) => {
    if (++nodes > PUBLIC_SHARE_LIMITS.nodes || depth > PUBLIC_SHARE_LIMITS.depth) throw new Error('Public snapshot exceeds the depth or node limit')
    if (typeof child === 'number' && !Number.isFinite(child)) throw new Error('Public snapshot contains a non-finite number')
    if (typeof child === 'string') textBytes += new TextEncoder().encode(child).length
    if (textBytes > PUBLIC_SHARE_LIMITS.bytes) throw new Error('Public snapshot exceeds 256 KiB; shorten optional notes')
    if (typeof child === 'string' && child.length > PUBLIC_SHARE_LIMITS.notes) throw new Error('Public snapshot contains overlong text; shorten notes or labels')
    if (child && typeof child === 'object') {
      if (!Array.isArray(child) && Object.getPrototypeOf(child) !== Object.prototype && Object.getPrototypeOf(child) !== null) throw new Error('Public snapshot must contain plain JSON objects')
      for (const [key, entry] of Object.entries(child)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Public snapshot contains an unsafe key')
        visit(entry, depth + 1)
      }
    }
  }
  visit(value, 0)
  if (new TextEncoder().encode(JSON.stringify(value)).length > PUBLIC_SHARE_LIMITS.bytes) throw new Error('Public snapshot exceeds 256 KiB; shorten optional notes or share a smaller selection')
}

export function validatePublicSnapshot(value: unknown): PublicSnapshot {
  bounded(value)
  const parsed = PublicSnapshotSchema.safeParse(value)
  if (!parsed.success) throw new Error(`Public snapshot is invalid: ${parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`)
  const snapshot = parsed.data
  if (snapshot.slots.length !== (snapshot.kind === 'build' ? 1 : 4) || snapshot.kind === 'build' && !snapshot.slots[0]) throw new Error('A Build needs one loadout; a Team needs exactly four ordered slots')
  if (snapshot.kind === 'build' && snapshot.slots[0]?.name !== undefined) throw new Error('Only Team slots have member names')
  if (snapshot.notes && snapshot.notes.slots.length !== snapshot.slots.length) throw new Error('Notes must follow the shared slot order')
  const selected = new Set<string>()
  const visitRefs = (entry: unknown): void => {
    if (!entry || typeof entry !== 'object') return
    if ('kind' in entry && (entry.kind === 'personal' || entry.kind === 'catalog')) { selected.add(publicRefKey(entry as PublicRef)); return }
    Object.values(entry).forEach(visitRefs)
  }
  visitRefs(snapshot.slots)
  const receipts = new Set(snapshot.receipts.map(receipt => publicRefKey(receipt.ref)))
  if (receipts.size !== snapshot.receipts.length || receipts.size !== selected.size || [...selected].some(key => !receipts.has(key))) throw new Error('Each selected entry needs exactly one display and source receipt')
  for (const receipt of snapshot.receipts) {
    if (receipt.ref.kind === 'personal') {
      if (receipt.origin.kind !== 'personal' || receipt.fingerprint?.kind !== 'personal-definition-v1' || receipt.fingerprint.value !== receipt.ref.fingerprint.value || receipt.origin.catalogId !== 'personal-definition-v1' || receipt.origin.projectId !== 'personal-definition-v1' || receipt.origin.catalogRevisionId !== receipt.ref.fingerprint.value || receipt.origin.sourceRevisionId !== receipt.ref.fingerprint.value) throw new Error('Personal receipts must match their selected content fingerprint')
    } else if (receipt.origin.kind !== 'catalog' || receipt.origin.catalogId !== receipt.ref.catalogId || receipt.origin.catalogRevisionId !== receipt.ref.catalogRevisionId) throw new Error('Catalog receipts must match the selected exact catalog identity')
  }
  if (new Set(snapshot.setup.slots.map(slot => slot.id)).size !== snapshot.setup.slots.length) throw new Error('Display slot IDs must be unique')
  for (const slot of snapshot.slots) {
    if (!slot) continue
    const ids = new Set(slot.equipment.map(entry => entry.slotId))
    if (ids.size !== slot.equipment.length) throw new Error('Equipment slot IDs must be unique')
    const selectedSlots = new Set(slot.equipment.filter(entry => entry.ref).map(entry => entry.slotId)), grouped = new Set<string>()
    let previousGroup = -1
    for (const group of slot.equipmentGroups) {
      let previousMember = -1
      for (const id of group) {
        if (!selectedSlots.has(id) || grouped.has(id)) throw new Error('Equipment groups need distinct selected slots, each in at most one group')
        const position = slot.equipment.findIndex(entry => entry.slotId === id)
        if (position <= previousMember) throw new Error('Equipment group members must follow selected slot order')
        if (previousMember === -1) {
          if (position <= previousGroup) throw new Error('Equipment groups must follow selected slot order')
          previousGroup = position
        }
        previousMember = position
        grouped.add(id)
      }
    }
  }
  return snapshot
}
