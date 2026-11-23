export function boundedPreparation(signal: AbortSignal, fixture: { dispose(): Promise<void> }, concurrency: number) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new RangeError('Expected positive preparation concurrency')
  const nativeDispose = fixture.dispose.bind(fixture)
  let active: Promise<unknown> | undefined
  let disposal: Promise<void> | undefined
  let closed = false

  function checkOpen() {
    if (signal.aborted) throw signal.reason
    if (closed) throw new Error('Preparation is closed')
  }

  // The fixture registry holds this same object, and native disposal invalidates outstanding uploads
  fixture.dispose = () => {
    closed = true
    disposal ??= Promise.allSettled(active ? [active] : []).then(() => nativeDispose())
    return disposal
  }

  function map<Input, Output>(inputs: readonly Input[], prepare: (input: Input) => Promise<Output>): Promise<Output[]> {
    if (active) return Promise.reject(new Error('A preparation map is already active'))
    // Register the entire map before a callback can start work or reenter disposal
    const task = Promise.resolve().then(async () => {
      checkOpen()
      const outputs: Output[] = []
      for (let start = 0; start < inputs.length; start += concurrency) {
        const batch = inputs.slice(start, start + concurrency)
        const settled = await Promise.allSettled(batch.map(async input => prepare(input)))
        const errors: unknown[] = []
        for (const result of settled) {
          if (result.status === 'rejected') errors.push(result.reason)
          else outputs.push(result.value)
        }
        if (errors.length === 1) throw errors[0]
        if (errors.length > 1) throw new AggregateError(errors, 'Multiple preparations failed')
        // A cancelled test body can outlive its caller and must not resume into publication
        checkOpen()
      }
      return outputs
    })
    active = task
    void task.then(() => { active = undefined }, () => { active = undefined; closed = true })
    return task
  }
  return { map }
}
