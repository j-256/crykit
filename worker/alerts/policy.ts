export type AlertCode = 'RATE_LIMITED' | 'SERVICE_PAUSED'
export const alertCooldownMs = 15 * 60_000
export const dailyAlertLimits = Object.freeze({ RATE_LIMITED: 8, SERVICE_PAUSED: 2 })
const dayMs = 86_400_000
export interface AlertState {
  readonly version: 1
  readonly day: number
  readonly sentRate: number
  readonly sentPause: number
  readonly lastRate: number | null
  readonly lastPause: number | null
  readonly observedRate: number
  readonly observedPause: number
}
function storedState(value: unknown): AlertState {
  // Never reset unknown state: that could reopen an already-spent notification allowance
  if (!value || typeof value !== 'object') throw new Error('ALERT_STATE_INVALID')
  const row = value as Record<string, unknown>
  const integer = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  if (row.version !== 1 || !['day', 'sentRate', 'sentPause', 'observedRate', 'observedPause'].every(key => integer(row[key])) || !['lastRate', 'lastPause'].every(key => row[key] === null || integer(row[key])) || (row.sentRate as number) > dailyAlertLimits.RATE_LIMITED || (row.sentPause as number) > dailyAlertLimits.SERVICE_PAUSED) throw new Error('ALERT_STATE_INVALID')
  return row as unknown as AlertState
}
export function claimAlert(previous: unknown, code: AlertCode, now: number, observations = 1): { readonly state: AlertState; readonly send: boolean; readonly observations: number } {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(observations) || observations < 1) throw new Error('INVALID_ALERT')
  const day = Math.floor(now / dayMs)
  let state: AlertState = previous === undefined ? { version: 1, day, sentRate: 0, sentPause: 0, lastRate: null, lastPause: null, observedRate: 0, observedPause: 0 } : storedState(previous)
  // A clock rollback cannot reopen a spent allowance; cooldown also survives a UTC day boundary
  if (day < state.day) return { state, send: false, observations: 0 }
  if (day > state.day) state = { ...state, day, sentRate: 0, sentPause: 0 }
  const rate = code === 'RATE_LIMITED'
  const last = rate ? state.lastRate : state.lastPause
  const count = Math.min(Number.MAX_SAFE_INTEGER, (rate ? state.observedRate : state.observedPause) + observations)
  const send = (last === null || now - last >= alertCooldownMs) && (rate ? state.sentRate : state.sentPause) < dailyAlertLimits[code]
  return {
    send, observations: count,
    state: rate
      ? { ...state, lastRate: send ? now : state.lastRate, sentRate: state.sentRate + Number(send), observedRate: send ? 0 : count }
      : { ...state, lastPause: send ? now : state.lastPause, sentPause: state.sentPause + Number(send), observedPause: send ? 0 : count },
  }
}
