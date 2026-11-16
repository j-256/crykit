import { expect, it } from 'vitest'
import { assessScheduledSigninMergeInputs, type ScheduledSigninMergeInput, type ScheduledSigninMergeProbe } from '../../e2e/accounts/signin-helpers'

const sample = (time: number): ScheduledSigninMergeInput => ({ id: time, phase: 'review', scheduledEpochMs: time, dispatchedEpochMs: time, completedEpochMs: time + 1, outcome: 'complete' })
const paint = (time: number, delay = 20) => ({ requestEpochMs: time, paintEpochMs: time + delay, trusted: true, keydownStartTime: time })
const phase = { name: 'review', trusted: true, startEpochMs: 1000, readyEpochMs: 1400 }
const assess = (probe: ScheduledSigninMergeProbe | null, samples = [1100, 1200, 1300].map(sample)) => assessScheduledSigninMergeInputs(probe, samples, ['review'])

it('admits scheduled input through the phase endpoint even when it paints after readiness', () => {
  const result = assess({ phases: [phase], paints: [paint(1100), paint(1200), paint(1300, 500)] })
  expect(result.wholePreparationResponsiveness).toBe(false)
  expect(result.scheduledInputReceipts[2]).toMatchObject({ inPhase: true, receiptStatus: 'associated', scheduledToPaintOpportunityMs: 500 })
})
it.each(['missing', 'duplicate', 'untrusted', 'unfinished'] as const)('never drops an in-phase %s input receipt', defect => {
  const paints = [paint(1100), paint(1200)]
  if (defect !== 'missing') paints.push({ ...paint(1300), ...(defect === 'untrusted' ? { trusted: false } : defect === 'unfinished' ? { paintEpochMs: NaN } : {}) })
  if (defect === 'duplicate') paints.push(paint(1300))
  const result = assess({ phases: [phase], paints })
  expect(result.wholePreparationResponsiveness).toBe(false)
  expect(result.scheduledInputReceipts[2].receiptStatus).toBe(defect)
})
it('reports a short unsampled phase and missing/ambiguous endpoints as unavailable', () => {
  expect(assess({ phases: [{ ...phase, readyEpochMs: 1050 }], paints: [] }, []).wholePreparationResponsiveness).toBeNull()
  for (const phases of [[], [phase, phase], [{ ...phase, readyEpochMs: undefined }], [{ ...phase, trusted: false }]]) {
    const result = assess({ phases, paints: [paint(1100), paint(1200), paint(1300)] })
    expect(result.wholePreparationResponsiveness).toBeNull()
    expect(result.review).toBeNull()
  }
  expect(assess(null).review).toBeNull()
})
it('requires schedule coverage and retains off-phase samples without counting them as coverage', () => {
  expect(assess({ phases: [phase], paints: [paint(1100), paint(1200), paint(1300)] }).wholePreparationResponsiveness).toBe(true)
  const result = assess({ phases: [phase], paints: [paint(1050), paint(1500)] }, [sample(1050), sample(1500)])
  expect(result.wholePreparationResponsiveness).toBe(false)
  expect(result.scheduledInputReceipts[1].inPhase).toBe(false)
  expect(result.phaseInputCoverage[0].maximumScheduledGapMs).toBe(350)
})
