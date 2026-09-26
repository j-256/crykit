import { describe, expect, it } from 'vitest'
import { detectSkillGrid, GRID_STEP, GRID_X, GRID_Y, SCREEN_HEIGHT, SCREEN_WIDTH } from './skill-grid'

function fixture() {
  const data = new Uint8ClampedArray(SCREEN_WIDTH * SCREEN_HEIGHT * 4)
  const pixel = (x: number, y: number, color: readonly number[]) => { data.set([...color, 255], (y * SCREEN_WIDTH + x) * 4) }
  const square = (row: number, column: number, color: readonly number[]) => {
    const x = GRID_X + column * GRID_STEP
    const y = GRID_Y + row * GRID_STEP
    for (let i = 0; i < 40; i++) { pixel(x, y + i, color); pixel(x + i, y, color) }
  }
  return { image: { data, width: SCREEN_WIDTH, height: SCREEN_HEIGHT }, pixel, square }
}

describe('Learn screen pixel analysis', () => {
  it('separates gold learning from blue availability and dim locked borders', () => {
    const { image, pixel, square } = fixture()
    square(0, 0, [192, 187, 40])
    square(0, 1, [32, 150, 212])
    square(1, 0, [66, 80, 89])
    for (let y = 211; y < 230; y++) pixel(624, y, [250, 250, 255])
    expect(detectSkillGrid(image)).toEqual({ selectedRow: 0, squares: [{ row: 0, column: 0, state: 'learned' }, { row: 0, column: 1, state: 'available' }, { row: 1, column: 0, state: 'locked' }] })
  })

  it('leaves mixed borders unknown and rejects ambiguous class highlights', () => {
    const { image, pixel, square } = fixture()
    square(0, 0, [192, 187, 40])
    for (let y = 7; y < 31; y++) pixel(GRID_X, GRID_Y + y, [32, 150, 212])
    for (const row of [0, 1]) for (let y = 211 + row * 28; y < 230 + row * 28; y++) pixel(624, y, [250, 250, 255])
    expect(detectSkillGrid(image).squares[0].state).toBe('unknown')
    expect(detectSkillGrid(image).selectedRow).toBeUndefined()
  })

  it('does not treat empty cells or a blank image as locked nodes', () => {
    const { image } = fixture()
    expect(detectSkillGrid(image)).toEqual({ squares: [] })
    expect(() => detectSkillGrid({ ...image, width: 640 })).toThrow()
  })
})
