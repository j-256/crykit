import { describe, expect, it } from 'vitest'
import { createSearchScheduler } from './search-scheduler'

describe('search task scheduling', () => {
  it('yields before executing search work', async () => {
    const scheduler = createSearchScheduler()
    let synchronous = true
    await new Promise<void>(resolve => {
      scheduler.schedule(() => { expect(synchronous).toBe(false); scheduler.close(); resolve() })
      synchronous = false
    })
  })
  it('cancels queued tasks and rejects work after closing', async () => {
    const scheduler = createSearchScheduler()
    let executed = false
    scheduler.schedule(() => { executed = true })
    scheduler.close()
    scheduler.schedule(() => { executed = true })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(executed).toBe(false)
  })
})
