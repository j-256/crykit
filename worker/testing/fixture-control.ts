import type { SafeEvent } from '../../src/account/protocol'

export const fixtureClockHeader = 'x-crykit-fixture-clock'
export const fixtureEventsPath = '/__accounts/probe/events'
export const fixtureMeasurementPath = '/__accounts/probe/measurement'
const retainedEvents: SafeEvent[] = []
const measurement = { events: 0, eventBytes: 0, eventGroups: {} as Record<string, number> }
const encoder = new TextEncoder()

// Each fixture owns its Worker isolate, so telemetry cannot cross test/backend lifetimes
// Browser proofs retain aggregates; Node assertions explicitly opt into complete event retention
export function recordFixtureEvent(event: SafeEvent, retain: boolean): void {
  if (retain) retainedEvents.push(event)
  measurement.events++
  measurement.eventBytes += encoder.encode(JSON.stringify(event)).byteLength
  const key = JSON.stringify([event.operation, event.stage, event.code])
  measurement.eventGroups[key] = (measurement.eventGroups[key] ?? 0) + 1
}

export function fixtureEvents(): readonly SafeEvent[] { return retainedEvents }
export function fixtureMeasurement() { return measurement }
