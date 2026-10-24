import { expect, it } from 'vitest'
import { claimAlert, alertCooldownMs, dailyAlertLimits } from './policy'

const start = Date.UTC(2026, 9, 20)
it('groupsRepeatedObservationsUntilTheCooldownAndReservesCapacityForServicePauses', () => {
  let result = claimAlert(undefined, 'RATE_LIMITED', start)
  expect(result.send).toBe(true)
  result = claimAlert(result.state, 'RATE_LIMITED', start + 1)
  expect(result.send).toBe(false)
  result = claimAlert(result.state, 'RATE_LIMITED', start + alertCooldownMs)
  expect(result).toMatchObject({ send: true, observations: 2 })
  for (let index = 2; index < dailyAlertLimits.RATE_LIMITED; index++) result = claimAlert(result.state, 'RATE_LIMITED', start + index * alertCooldownMs)
  result = claimAlert(result.state, 'RATE_LIMITED', start + dailyAlertLimits.RATE_LIMITED * alertCooldownMs)
  expect(result.send).toBe(false)
  expect(claimAlert(result.state, 'SERVICE_PAUSED', start + dailyAlertLimits.RATE_LIMITED * alertCooldownMs).send).toBe(true)
})
it('preservesCooldownAcrossMidnightAndDoesNotResetLimitsWhenTheClockMovesBack', () => {
  const midnight = start + 86_400_000
  const first = claimAlert(undefined, 'RATE_LIMITED', midnight - 1)
  const next = claimAlert(first.state, 'RATE_LIMITED', midnight)
  expect(next.send).toBe(false)
  expect(claimAlert(next.state, 'RATE_LIMITED', midnight + alertCooldownMs).send).toBe(true)
  expect(claimAlert(next.state, 'RATE_LIMITED', start).send).toBe(false)
})
it('failsClosedOnUnknownOrCorruptOperationalState', () => {
  for (const value of [{ version: 2 }, { version: 1 }, { ...claimAlert(undefined, 'RATE_LIMITED', start).state, sentRate: -1 }]) {
    expect(() => claimAlert(value, 'RATE_LIMITED', start)).toThrow('ALERT_STATE_INVALID')
  }
})
