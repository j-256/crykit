import { act, StrictMode, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useQueuedTileUpdates } from './useQueuedTileUpdates'

const STAGE_COUNT = 4
type SavedStages = Readonly<Record<string, number>>
interface SaveRequest {
  readonly key: string
  readonly resolve: () => void
  readonly reject: (reason: unknown) => void
}

let container: HTMLDivElement
let root: Root
let requests: SaveRequest[]
let synchronousFailure: boolean

function Harness({ saved }: { readonly saved: SavedStages }) {
  const { queuedUpdates, pendingCount, enqueue } = useQueuedTileUpdates<string, number>()
  const [error, setError] = useState('')
  return <><output>{pendingCount}</output><p>{error}</p>{Object.entries(saved).map(([key, baseState]) => <button data-pending={queuedUpdates.has(key)} data-state={queuedUpdates.get(key)?.state ?? baseState} id={key} key={key} onClick={() => enqueue(key, baseState, state => (state + 1) % STAGE_COUNT, () => {
    if (synchronousFailure) throw new Error('Synchronous save failure')
    return new Promise<void>((resolve, reject) => { requests.push({ key, resolve, reject }) })
  }, reason => setError((reason as Error).message))} type="button">{key}</button>)}</>
}

function render(saved: SavedStages) {
  root.render(<StrictMode><Harness saved={saved}/></StrictMode>)
}

function button(key: string) {
  return container.querySelector<HTMLButtonElement>(`#${key}`)!
}

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  requests = []
  synchronousFailure = false
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('queued tile updates', () => {
  it('holds the latest requested state through intermediate acknowledgments and drains each key independently', async () => {
    await act(async () => render({ first: 0, second: 0 }))
    await act(async () => {
      for (let index = 0; index < 7; index += 1) button('first').click()
      button('second').click()
      expect(requests.map(request => request.key)).toEqual([...Array<string>(7).fill('first'), 'second'])
    })
    expect(button('first').dataset).toMatchObject({ state: '3', pending: 'true' })
    expect(button('second').dataset).toMatchObject({ state: '1', pending: 'true' })
    expect(button('first').disabled).toBe(false)
    expect(container.querySelector('output')!.textContent).toBe('8')
    await act(async () => { render({ first: 1, second: 0 }); requests[0]!.resolve() })
    expect(button('first').dataset).toMatchObject({ state: '3', pending: 'true' })
    await act(async () => { render({ first: 1, second: 1 }); requests[7]!.resolve() })
    expect(button('second').dataset).toMatchObject({ state: '1', pending: 'false' })
    for (let index = 1; index < 7; index += 1) {
      await act(async () => { render({ first: (index + 1) % STAGE_COUNT, second: 1 }); requests[index]!.resolve() })
      expect(button('first').dataset.state).toBe('3')
    }
    expect(button('first').dataset.pending).toBe('false')
    expect(container.querySelector('output')!.textContent).toBe('0')
    await act(async () => button('first').click())
    expect(button('first').dataset.state).toBe('0')
    await act(async () => { render({ first: 0, second: 1 }); requests[8]!.resolve() })
  })

  it('reports a rejected save while retaining later intentions until their final saved state is available', async () => {
    await act(async () => render({ first: 0 }))
    await act(async () => { button('first').click(); button('first').click() })
    await act(async () => requests[0]!.reject(new Error('Quota exceeded')))
    expect(container.querySelector('p')!.textContent).toBe('Quota exceeded')
    expect(button('first').dataset).toMatchObject({ state: '2', pending: 'true' })
    await act(async () => { render({ first: 1 }); requests[1]!.resolve() })
    expect(button('first').dataset).toMatchObject({ state: '1', pending: 'false' })
    expect(container.querySelector('output')!.textContent).toBe('0')
  })

  it('settles synchronous save errors without leaving a tile stuck pending', async () => {
    synchronousFailure = true
    await act(async () => render({ first: 0 }))
    await act(async () => button('first').click())
    expect(container.querySelector('p')!.textContent).toBe('Synchronous save failure')
    expect(button('first').dataset).toMatchObject({ state: '0', pending: 'false' })
    expect(container.querySelector('output')!.textContent).toBe('0')
  })
})
