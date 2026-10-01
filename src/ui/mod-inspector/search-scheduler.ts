export function createSearchScheduler() {
  const channel = typeof MessageChannel === 'function' ? new MessageChannel() : undefined
  let pending: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  if (channel) channel.port1.onmessage = () => { const task = pending; pending = undefined; if (!closed) task?.() }
  return {
    schedule(task: () => void) {
      if (closed) return
      if (channel) { pending = task; channel.port2.postMessage(null) }
      else timer = setTimeout(() => { if (!closed) task() }, 0)
    },
    close() {
      closed = true; pending = undefined
      if (timer !== undefined) clearTimeout(timer)
      channel?.port1.close(); channel?.port2.close()
    },
  }
}
