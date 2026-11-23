import { expect, it, vi } from 'vitest'
import { boundedPreparation } from './bounded-preparation'

function deferred() {
  let resolve!: () => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<void>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

function heldOperations(size: number) {
  const started = Array.from({ length: size }, deferred)
  const gates = Array.from({ length: size }, deferred)
  const finished = Array.from({ length: size }, deferred)
  const items = gates.map((_, index) => index)
  const events: string[] = []
  const active = new Set<number>()
  let peak = 0
  async function prepare(item: number) {
    events.push(`start ${item}`)
    active.add(item)
    peak = Math.max(peak, active.size)
    started[item].resolve()
    try {
      await gates[item].promise
      return `result ${item}`
    } finally {
      active.delete(item)
      events.push(`finish ${item}`)
      finished[item].resolve()
    }
  }
  return { items, started, gates, finished, prepare, events, peak: () => peak }
}

it('waits for each complete batch and returns results in input order', async () => {
  const held = heldOperations(6)
  const fixture = { dispose: vi.fn(async () => {}) }
  const owner = boundedPreparation(new AbortController().signal, fixture, 4)
  const result = owner.map(held.items, held.prepare)
  await held.started[3].promise
  await expect(owner.map(held.items, held.prepare)).rejects.toThrow('already active')
  for (const index of [3, 2, 0]) {
    held.gates[index].resolve()
    await held.finished[index].promise
  }
  expect(held.events.filter(event => event.startsWith('start'))).toEqual(['start 0', 'start 1', 'start 2', 'start 3'])
  held.gates[1].resolve()
  await held.started[5].promise
  held.gates[5].resolve()
  held.gates[4].resolve()
  await expect(result).resolves.toEqual(held.items.map(item => `result ${item}`))
  expect(held.peak()).toBe(4)
  await expect(owner.map([6], async item => item)).resolves.toEqual([6])
  await fixture.dispose()
})

it.each([1, 2])('preserves %i preparation errors after all started siblings settle', async failures => {
  const held = heldOperations(5)
  const controller = new AbortController()
  const fixture = { dispose: async () => { held.events.push('dispose') } }
  const owner = boundedPreparation(controller.signal, fixture, 4)
  const result = owner.map(held.items, held.prepare)
  const outcome = result.then(() => 'unexpected success', error => { held.events.push('map rejected'); return error })
  await held.started[3].promise
  const errors = [new Error('first upload'), new Error('second upload')].slice(0, failures)
  errors.forEach((error, at) => held.gates[at].reject(error))
  await Promise.all(errors.map((_, at) => held.finished[at].promise))
  if (failures > 1) controller.abort(new Error('cancelled with uploads in flight'))
  const cleanup = fixture.dispose()
  expect(held.events).not.toContain('map rejected')
  expect(held.events).not.toContain('dispose')
  for (let at = failures; at < 4; at++) held.gates[at].resolve()
  const error = await outcome
  if (failures === 1) expect(error).toBe(errors[0])
  else {
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.errors).toEqual(errors)
  }
  await cleanup
  expect(held.events).not.toContain('start 4')
  expect(held.events.slice(-3)).toEqual(['finish 3', 'map rejected', 'dispose'])
})

it.each([4, 5])('blocks publication on abort with %i inputs and drains before native disposal', async size => {
  const held = heldOperations(size)
  const controller = new AbortController()
  const fixture = { dispose: async () => { held.events.push('dispose') } }
  const owner = boundedPreparation(controller.signal, fixture, 4)
  const published = owner.map(held.items, held.prepare).then(() => held.events.push('publish'))
  const reason = new Error('timed out')
  const rejection = expect(published).rejects.toBe(reason)
  await held.started[3].promise
  controller.abort(reason)
  const cleanup = fixture.dispose()
  for (let at = 0; at < 4; at++) {
    expect(held.events).not.toContain('dispose')
    held.gates[at].resolve()
    await held.finished[at].promise
  }
  await rejection
  await cleanup
  expect(held.events).toEqual(['start 0', 'start 1', 'start 2', 'start 3', 'finish 0', 'finish 1', 'finish 2', 'finish 3', 'dispose'])
})

it('stops an active map on fixture disposal even when the test signal stays open', async () => {
  const held = heldOperations(5)
  const fixture = { dispose: async () => { held.events.push('dispose') } }
  const owner = boundedPreparation(new AbortController().signal, fixture, 4)
  const result = owner.map(held.items, held.prepare)
  const rejection = expect(result).rejects.toThrow('closed')
  await held.started[3].promise
  const cleanup = fixture.dispose()
  for (let at = 0; at < 4; at++) held.gates[at].resolve()
  await rejection
  await cleanup
  expect(held.events).not.toContain('start 4')
  expect(held.events.at(-1)).toBe('dispose')
})

it('refuses new work when closed or already aborted and shares native disposal failure', async () => {
  const reason = new Error('cancelled')
  const failure = new Error('native dispose')
  const native = vi.fn(async () => { throw failure })
  const fixture = { dispose: native }
  const controller = new AbortController()
  const owner = boundedPreparation(controller.signal, fixture, 4)
  const prepare = vi.fn(async () => 1)
  const cleanup = fixture.dispose()
  expect(fixture.dispose()).toBe(cleanup)
  await expect(cleanup).rejects.toBe(failure)
  await expect(owner.map([1], prepare)).rejects.toThrow('closed')
  expect(native).toHaveBeenCalledTimes(1)
  controller.abort(reason)
  const aborted = boundedPreparation(controller.signal, { dispose: async () => {} }, 4)
  await expect(aborted.map([1], prepare)).rejects.toBe(reason)
  expect(prepare).not.toHaveBeenCalled()
})
