import { SKILL_GRID_COLUMNS, SKILL_GRID_ROWS } from '../domain/skill-trees'
import type { SkillSquare, SkillSquareState } from '../domain/types'

export const SCREEN_WIDTH = 1280
export const SCREEN_HEIGHT = 720
export const GRID_X = 670
export const GRID_Y = 222
export const GRID_STEP = 64
export const SQUARE_SIZE = 40

export interface Pixels { readonly width: number; readonly height: number; readonly data: Uint8ClampedArray }

function pixel(image: Pixels, x: number, y: number): readonly number[] {
  const index = (y * image.width + x) * 4
  return [image.data[index], image.data[index + 1], image.data[index + 2]]
}

function color(r: number, g: number, b: number): SkillSquareState {
  if (r > 130 && g > 120 && b < Math.min(r, g) * 0.75) return 'learned'
  if (b > 110 && g > 65 && b > r * 1.5 && g > r * 1.2) return 'available'
  if (r > 35 && r < 120 && g >= r && b >= g && b < 145) return 'locked'
  return 'unknown'
}

export function detectSkillGrid(image: Pixels): { readonly squares: readonly SkillSquare[]; readonly selectedRow?: number } {
  if (image.width !== SCREEN_WIDTH || image.height !== SCREEN_HEIGHT || image.data.length !== SCREEN_WIDTH * SCREEN_HEIGHT * 4) throw new Error('Unsupported screenshot dimensions')
  const squares: SkillSquare[] = []
  for (let row = 0; row < SKILL_GRID_ROWS; row++) {
    for (let column = 0; column < SKILL_GRID_COLUMNS; column++) {
      const x = GRID_X + column * GRID_STEP
      const y = GRID_Y + row * GRID_STEP
      const votes: Record<SkillSquareState, number> = { learned: 0, available: 0, locked: 0, unknown: 0 }
      let edges = 0
      for (let offset = 7; offset < 31; offset++) {
        for (const [px, py] of [[x, y + offset], [x + offset, y], [x + 1, y + offset], [x + offset, y + 1]]) {
          const [r, g, b] = pixel(image, px, py)
          const state = color(r, g, b)
          votes[state]++
          if (state !== 'unknown') edges++
        }
      }
      if (edges < 38) continue
      const best = (['learned', 'available', 'locked'] as const).reduce((a, b) => votes[a] > votes[b] ? a : b)
      squares.push({ row, column, state: votes[best] >= 38 && votes[best] / edges >= 0.85 ? best : 'unknown' })
    }
  }
  const selectedRows: number[] = []
  for (let row = 0; row < 13; row++) {
    const y = 208 + row * 28
    let white = 0
    for (let offset = 3; offset < 21; offset++) {
      const [r, g, b] = pixel(image, 624, y + offset)
      if (r > 135 && g > 135 && b > 135 && Math.max(r, g, b) - Math.min(r, g, b) < 65) white++
    }
    if (white >= 8) selectedRows.push(row)
  }
  return { squares, ...(selectedRows.length === 1 ? { selectedRow: selectedRows[0] } : {}) }
}
