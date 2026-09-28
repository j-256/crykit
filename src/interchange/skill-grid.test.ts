import { describe, expect, it } from 'vitest'
import { detectSkillGrid } from './skill-grid'
import { SKILL_BORDER_COLORS, skillGridFixture } from './skill-grid.test-helpers'

describe('Learn screen pixel analysis', () => {
  it('separates gold learning from blue availability and dim locked borders', () => {
    const { image, square, highlight } = skillGridFixture()
    square(0, 0, SKILL_BORDER_COLORS.learned)
    square(0, 1, SKILL_BORDER_COLORS.available)
    square(1, 0, SKILL_BORDER_COLORS.locked)
    highlight(0)
    expect(detectSkillGrid(image)).toEqual({ selectedRow: 0, squares: [{ row: 0, column: 0, state: 'learned' }, { row: 0, column: 1, state: 'available' }, { row: 1, column: 0, state: 'locked' }] })
  })

  it('leaves mixed borders unknown and rejects ambiguous class highlights', () => {
    const { image, square, highlight } = skillGridFixture()
    square(0, 0, SKILL_BORDER_COLORS.learned, SKILL_BORDER_COLORS.available)
    for (const row of [0, 1]) highlight(row)
    expect(detectSkillGrid(image).squares[0].state).toBe('unknown')
    expect(detectSkillGrid(image).selectedRow).toBeUndefined()
  })

  it('does not treat empty cells or a blank image as locked nodes', () => {
    const { image } = skillGridFixture()
    expect(detectSkillGrid(image)).toEqual({ squares: [] })
    expect(() => detectSkillGrid({ ...image, width: 640 })).toThrow()
  })
})
