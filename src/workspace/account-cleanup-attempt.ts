import type { ProfileToken } from '../account/profile'
import type { AccountDatabase } from '../persistence/account-database'
import type { AccountPreparationOwner } from './account-prepared-records'

export type AccountCleanupResult =
  | { readonly attempt: number; readonly status: 'succeeded' }
  | { readonly attempt: number; readonly status: 'failed'; readonly errors: readonly unknown[] }
type FailedCleanupResult = Extract<AccountCleanupResult, { readonly status: 'failed' }>
export type AccountCleanupObservation =
  | { readonly attempt: 0; readonly status: 'not-started' }
  | { readonly attempt: number; readonly status: 'pending' }
  | AccountCleanupResult
export interface AccountCleanupJoin {
  observe(): AccountCleanupObservation
  request(): Promise<AccountCleanupResult>
  wait(): Promise<AccountCleanupObservation>
}
export interface AccountCleanupGroup extends AccountCleanupJoin {
  include(part: AccountCleanupJoin): void
}
export interface AccountManagedCleanup {
  owner(owner: AccountPreparationOwner): AccountCleanupJoin
  reader(reader: { dispose(): Promise<void> }): AccountCleanupJoin
  group(parts: readonly AccountCleanupJoin[]): AccountCleanupGroup
}

const STATUS = Object.freeze({ dormant: 'not-started', pending: 'pending', succeeded: 'succeeded', failed: 'failed' } as const)
const NOT_STARTED = Object.freeze({ attempt: 0, status: STATUS.dormant } as const)
interface Attempt {
  readonly promise: Promise<AccountCleanupResult>
  observation: AccountCleanupObservation
}
interface Resource {
  readonly kind: 'resource'
  readonly join: AccountCleanupJoin
  readonly execute: readonly (() => Promise<void>)[]
  readonly history: AccountCleanupResult[]
  current?: Attempt
  retryWave: number
}
interface Group {
  readonly kind: 'group'
  readonly join: AccountCleanupGroup
  readonly members: Set<Node>
  readonly parents: Set<Group>
  requested: boolean
}
type Node = Resource | Group
interface Registration { readonly coordinator: object; readonly node: Node }
const registrations = new WeakMap<object, Registration>()
// Claims outlive individual attempts, including successful disposal, so a second coordinator
// cannot turn the same raw object into a fresh cleanup authority
const claims = new WeakMap<object, Registration>()
const failures = new WeakMap<object, { readonly primary: unknown; readonly cleanup: AccountCleanupJoin }>()
// Only an exact request result proves that a registered join made a failed attempt;
// group observations recompute lookalike values and confer no cleanup authority
const requestResults = new WeakMap<object, AccountCleanupJoin>()
// Exact request results retain the physical attempts they reported, even after a retry
// or late group include changes the join's live observation
const failedAttempts = new WeakMap<object, ReadonlySet<Attempt>>()
interface CleanupOnlyFailure {
  readonly cleanup: AccountCleanupJoin
  readonly result: FailedCleanupResult
  readonly history?: readonly Error[]
}
const cleanupOnlyFailures = new WeakMap<object, CleanupOnlyFailure>()

export function accountPreparationFailure(primary: unknown, cleanup: AccountCleanupJoin): Error {
  if (!registrations.has(cleanup)) throw new Error('Unregistered account cleanup join')
  const error = new Error('Account preparation failed', { cause: primary })
  failures.set(error, Object.freeze({ primary, cleanup }))
  return error
}

export function readAccountPreparationFailure(error: unknown): { readonly primary: unknown; readonly cleanup: AccountCleanupJoin } | undefined {
  return typeof error === 'object' && error !== null ? failures.get(error) : undefined
}

export function accountCleanupOnlyFailure(cleanup: AccountCleanupJoin, result: AccountCleanupResult, preceding?: Error): Error {
  const registration = registrations.get(cleanup)
  if (!registration || result.status !== STATUS.failed || requestResults.get(result) !== cleanup) throw new Error('Unregistered account cleanup attempt')
  const prior = preceding === undefined ? undefined : cleanupOnlyFailures.get(preceding)
  if (preceding !== undefined && (!prior || registrations.get(prior.cleanup)?.coordinator !== registration.coordinator)) throw new Error('Foreign or unregistered account cleanup-only history')
  if (!prior) {
    const error = new AggregateError(result.errors, 'Account cleanup failed')
    cleanupOnlyFailures.set(error, Object.freeze({ cleanup, result }))
    return error
  }
  // Latest request results cannot contain an earlier failed attempt after explicit retry;
  // retain its exact registered carrier separately from the canonical latest result
  const history = Object.freeze([preceding!, ...(prior.history ?? [])])
  const errors = [...result.errors]
  const seen = new Set(errors)
  for (const historical of history) {
    for (const historicalError of cleanupOnlyFailures.get(historical)!.result.errors) {
      if (!seen.has(historicalError)) { seen.add(historicalError); errors.push(historicalError) }
    }
  }
  const error = new AggregateError(errors, 'Account cleanup failed', { cause: preceding })
  cleanupOnlyFailures.set(error, Object.freeze({ cleanup, result, history }))
  return error
}

export function readAccountCleanupOnlyFailure(error: unknown): CleanupOnlyFailure | undefined {
  return typeof error === 'object' && error !== null ? cleanupOnlyFailures.get(error) : undefined
}

export function hasNewAccountCleanupFailure(latest: AccountCleanupResult, prior: AccountCleanupResult): boolean {
  // Observation shapes cannot prove request authority or a physical attempt's identity
  const latestJoin = requestResults.get(latest), priorJoin = requestResults.get(prior)
  if (!latestJoin || !priorJoin) throw new Error('Account cleanup comparison requires exact registered request results')
  if (registrations.get(latestJoin)?.coordinator !== registrations.get(priorJoin)?.coordinator) throw new Error('Foreign account cleanup request result')
  const current = failedAttempts.get(latest), historical = failedAttempts.get(prior)
  if (!current || !historical) throw new Error('Account cleanup request provenance is missing')
  return [...current].some(attempt => !historical.has(attempt))
}

function result(attempt: number, errors: readonly unknown[]): AccountCleanupResult {
  return errors.length
    ? Object.freeze({ attempt, status: STATUS.failed, errors: Object.freeze([...errors]) })
    : Object.freeze({ attempt, status: STATUS.succeeded })
}

function aggregate(observations: readonly AccountCleanupObservation[], requested: boolean): AccountCleanupObservation {
  const attempt = observations.reduce((maximum, value) => Math.max(maximum, value.attempt), 0)
  const errors = observations.flatMap(value => value.status === STATUS.failed ? value.errors : [])
  // A known failure remains visible beside pending work; observation is not an all-settled
  // barrier, so retry separately waits every resource before considering advancement
  if (observations.some(value => value.status === STATUS.failed)) return result(attempt, errors)
  if (!attempt) return observations.length || !requested ? NOT_STARTED : result(0, [])
  if (observations.some(value => value.status === STATUS.pending || value.status === STATUS.dormant)) return Object.freeze({ attempt, status: STATUS.pending })
  return result(attempt, [])
}

function resources(nodes: readonly Node[]): Resource[] {
  const found = new Set<Resource>()
  const visited = new Set<Group>()
  const visit = (node: Node) => {
    if (node.kind === 'resource') found.add(node)
    else if (!visited.has(node)) { visited.add(node); node.members.forEach(visit) }
  }
  nodes.forEach(visit)
  return [...found]
}

function reaches(node: Node, target: Group, visited = new Set<Node>()): boolean {
  if (node === target) return true
  if (node.kind === 'resource' || visited.has(node)) return false
  visited.add(node)
  return [...node.members].some(member => reaches(member, target, visited))
}

// Catch paths must validate a nested join without enrolling it in an already requested
// parent group, which would turn a historical child failure into a new parent failure
export function assertAccountCleanupJoinable(base: AccountCleanupJoin, part: AccountCleanupJoin): void {
  const left = registrations.get(base), right = registrations.get(part)
  if (!left || !right || left.coordinator !== right.coordinator) throw new Error('Foreign or unregistered account cleanup join')
  if (left.node.kind === 'group' && reaches(right.node, left.node)) throw new Error('Cyclic account cleanup group')
}

function start(node: Resource): Promise<AccountCleanupResult> {
  let resolve!: (value: AccountCleanupResult) => void
  const promise = new Promise<AccountCleanupResult>(done => { resolve = done })
  const attempt = (node.current?.observation.attempt ?? 0) + 1
  const current: Attempt = { promise, observation: Object.freeze({ attempt, status: STATUS.pending }) }
  // Install before calling raw code: synchronous reentrant request must join this very promise
  node.current = current
  const outcomes = node.execute.map(execute => {
    try {
      // Observe each call before invoking the next one; releaseReaders must start even if
      // abandon throws or waits on a stage that still holds prepared plaintext
      return Promise.resolve(execute()).then(
        () => ({ status: STATUS.succeeded } as const),
        (error: unknown) => ({ status: STATUS.failed, error } as const),
      )
    } catch (error) { return Promise.resolve({ status: STATUS.failed, error } as const) }
  })
  void Promise.all(outcomes).then(values => {
    const settled = result(attempt, values.flatMap(value => value.status === STATUS.failed ? [value.error] : []))
    requestResults.set(settled, node.join)
    failedAttempts.set(settled, settled.status === STATUS.failed ? new Set([current]) : new Set())
    current.observation = settled
    node.history.push(settled)
    resolve(settled)
  })
  return promise
}

export function createAccountCleanupCoordinator(
  database: AccountDatabase,
  token: ProfileToken,
  settlePreparations: (parts: readonly AccountCleanupJoin[]) => Promise<void>,
): { readonly cleanup: AccountManagedCleanup; retryFailed(parts: readonly AccountCleanupJoin[]): Promise<void> } {
  const { accountId, generation } = token
  if (database.accountId !== accountId) throw new Error('Account cleanup belongs to another workspace')
  const coordinator = {}
  let tail = Promise.resolve()
  let wave = 0
  let activeWave: number | undefined

  const registered = (join: AccountCleanupJoin): Node => {
    const registration = registrations.get(join)
    if (!registration || registration.coordinator !== coordinator) throw new Error('Foreign or unregistered account cleanup join')
    return registration.node
  }
  const intern = (raw: object, execute: readonly (() => Promise<void>)[]): AccountCleanupJoin => {
    const existing = claims.get(raw)
    if (existing) {
      if (existing.coordinator !== coordinator) throw new Error('Account cleanup resource already claimed')
      return existing.node.join
    }
    const node: Resource = {
      kind: 'resource', execute, history: [], retryWave: 0,
      join: Object.freeze({
        observe: () => node.current?.observation ?? NOT_STARTED,
        request: () => node.current?.promise ?? start(node),
        wait: () => node.current?.promise ?? Promise.resolve(NOT_STARTED),
      }),
    }
    const registration = { coordinator, node }
    registrations.set(node.join, registration)
    claims.set(raw, registration)
    return node.join
  }
  const isRequested = (group: Group): boolean => group.requested || [...group.parents].some(isRequested)
  const cleanup: AccountManagedCleanup = Object.freeze({
    owner(owner: AccountPreparationOwner) {
      // Cleanup identity is independent of live-profile admission and remains valid after
      // invalidation or transfer; calling owner.check here would strand those reservations
      if (owner.database !== database || owner.token.accountId !== accountId || owner.token.generation !== generation) throw new Error('Account cleanup owner belongs to another workspace')
      return intern(owner, [() => owner.abandon(), () => owner.releaseReaders()])
    },
    reader(reader: { dispose(): Promise<void> }) { return intern(reader, [() => reader.dispose()]) },
    group(parts: readonly AccountCleanupJoin[]): AccountCleanupGroup {
      const initial = parts.map(registered)
      const group: Group = {
        kind: 'group', members: new Set(), parents: new Set(), requested: false,
        join: Object.freeze({
          observe: () => aggregate(resources([group]).map(node => node.join.observe()), group.requested),
          request: () => {
            // Mark the ancestor before invoking a child so reentrant and late includes start
            // immediately; this finite snapshot does not seal the producer's future inventory
            group.requested = true
            const pending = resources([group]).map(node => node.join.request())
            return Promise.all(pending).then(values => {
              const settled = aggregate(values, true) as AccountCleanupResult
              requestResults.set(settled, group.join)
              // Use this invocation's finite exact child results, not later group membership
              const attempts = new Set<Attempt>()
              for (const value of values) {
                const captured = failedAttempts.get(value)
                if (!captured) throw new Error('Account cleanup request provenance is missing')
                for (const attempt of captured) attempts.add(attempt)
              }
              failedAttempts.set(settled, attempts)
              return settled
            })
          },
          wait: () => {
            const requested = group.requested
            const pending = resources([group]).map(node => node.join.wait())
            return Promise.all(pending).then(values => aggregate(values, requested))
          },
          include: (part: AccountCleanupJoin) => {
            assertAccountCleanupJoinable(group.join, part)
            const node = registrations.get(part)!.node
            if (group.members.has(node)) return
            group.members.add(node)
            if (node.kind === 'group') node.parents.add(group)
            if (isRequested(group)) for (const resource of resources([node])) void resource.join.request()
          },
        }),
      }
      registrations.set(group.join, { coordinator, node: group })
      for (const node of initial) group.join.include(node.join)
      return group.join
    },
  })

  function retryFailed(parts: readonly AccountCleanupJoin[]): Promise<void> {
    let targets: readonly AccountCleanupJoin[]
    let nodes: Node[]
    try { targets = Object.freeze([...parts]); nodes = targets.map(registered) }
    catch (error) { return Promise.reject(error) }
    // Calls overlapping a wave authorize that wave's attempt, even if it fails again before
    // their turn on the lock; only a later explicit call can authorize another retry
    const eligibleFrom = activeWave ?? wave + 1
    const run = tail.then(async () => {
      const thisWave = ++wave
      activeWave = thisWave
      try {
        // Preserve group identity (including empty groups) for the future producer barrier
        // This callback must settle inner work, never a runner that awaits this cleanup
        await settlePreparations(targets)
        const selected = resources(nodes)
        await Promise.all(selected.map(node => node.join.wait()))
        const attempts = selected.map(node => {
          if (node.current?.observation.status === STATUS.failed && node.retryWave < eligibleFrom) {
            node.retryWave = thisWave
            return start(node)
          }
          return node.join.wait()
        })
        const outcomes = await Promise.all(attempts)
        const errors = outcomes.flatMap(value => value.status === STATUS.failed ? value.errors : [])
        if (outcomes.some(value => value.status === STATUS.failed)) throw new AggregateError(errors, 'Account cleanup failed')
      } finally { activeWave = undefined }
    })
    // The lock observes rejection immediately and stays usable after either cleanup or barrier
    // failure; callers still receive the original rejection from their own invocation
    tail = run.then(() => undefined, () => undefined)
    return run
  }
  return Object.freeze({ cleanup, retryFailed })
}
