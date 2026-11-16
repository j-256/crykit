interface BodyRef {
  readonly documentId: string
  readonly revisionId: string
  readonly byteLength: number
  readonly sha256: string
  readonly encoding: string
}
interface BodyEvidence { readonly ref: BodyRef; readonly digest: string }
interface OriginalPublicationEvidence {
  readonly bodies: readonly BodyEvidence[]
  readonly bodyRoles: {
    readonly historicalMembers: readonly { readonly nativeRefs: readonly BodyRef[]; readonly catalogRefs: readonly BodyRef[] }[]
    readonly currentNativeRefs: readonly BodyRef[]
    readonly publishableNativeRefs: readonly BodyRef[]
    readonly requiredRefs: readonly BodyRef[]
    readonly pendingTargets: readonly { readonly kind: string; readonly unit: { readonly privateKey: string }; readonly root: BodyRef; readonly index: BodyRef }[]
  }
}
const fullRef = (ref: BodyRef) => JSON.stringify([ref.documentId, ref.revisionId, ref.byteLength, ref.sha256, ref.encoding])

// Operational wrappers may disappear on another device, but a projection cannot authorize its own omissions
// Require exact pending target identity and reject any overlap with original or conflict reachability
export function originalPublicationBodies(evidence: OriginalPublicationEvidence) {
  const { bodies, bodyRoles: roles } = evidence
  const all = new Set(bodies.map(body => fullRef(body.ref)))
  for (const body of bodies) if (body.digest !== body.ref.sha256) throw new Error('Original body hash mismatch')
  const current = new Set(roles.currentNativeRefs.map(fullRef)), published = new Set(roles.publishableNativeRefs.map(fullRef))
  const historical = new Set(roles.historicalMembers.flatMap(member => [...member.nativeRefs, ...member.catalogRefs]).map(fullRef))
  const required = new Set([...roles.requiredRefs.map(fullRef), ...historical])
  for (const ref of [...current, ...required]) if (!all.has(ref)) throw new Error('Missing original role body')
  for (const ref of published) if (!current.has(ref)) throw new Error('Foreign publication role')
  const wrappers = new Set(roles.pendingTargets.filter(entry => entry.kind === 'pending-content' && entry.unit.privateKey).flatMap(entry => [fullRef(entry.root), fullRef(entry.index)]))
  // Inherited members publish their exact original subsets independently of current operational roles
  const omitted = new Set([...current].filter(ref => !published.has(ref) && !historical.has(ref)))
  for (const ref of omitted) {
    if (!wrappers.has(ref)) throw new Error('Unclassified publication omission')
    if (required.has(ref)) throw new Error('Publication omitted required original or conflict body')
  }
  return { published: bodies.filter(body => !omitted.has(fullRef(body.ref))), omitted: bodies.filter(body => omitted.has(fullRef(body.ref))) }
}
