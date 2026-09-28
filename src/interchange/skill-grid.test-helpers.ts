import { GRID_STEP, GRID_X, GRID_Y, SCREEN_HEIGHT, SCREEN_WIDTH, SQUARE_SIZE } from './skill-grid'

const PIXEL_CHANNELS = 4
const OPAQUE_ALPHA = 255
const HIGHLIGHT_X = 624
const HIGHLIGHT_Y = 211
const HIGHLIGHT_HEIGHT = 19
const CLASS_ROW_HEIGHT = 28
const HIGHLIGHT_COLOR = [250, 250, 255] as const

export const SKILL_BORDER_COLORS = {
  learned: [192, 187, 40],
  available: [32, 150, 212],
  locked: [66, 80, 89],
} as const

export function skillGridFixture() {
  const data = new Uint8ClampedArray(SCREEN_WIDTH * SCREEN_HEIGHT * PIXEL_CHANNELS)
  const pixel = (x: number, y: number, color: readonly number[]) => {
    data.set([...color, OPAQUE_ALPHA], (y * SCREEN_WIDTH + x) * PIXEL_CHANNELS)
  }
  const square = (row: number, column: number, color: readonly number[], verticalColor: readonly number[] = color) => {
    const x = GRID_X + column * GRID_STEP
    const y = GRID_Y + row * GRID_STEP
    for (let offset = 0; offset < SQUARE_SIZE; offset++) {
      pixel(x + offset, y, color)
      pixel(x + offset, y + SQUARE_SIZE - 1, color)
      pixel(x, y + offset, verticalColor)
      pixel(x + SQUARE_SIZE - 1, y + offset, verticalColor)
    }
  }
  const highlight = (row: number) => {
    for (let offset = 0; offset < HIGHLIGHT_HEIGHT; offset++) {
      pixel(HIGHLIGHT_X, HIGHLIGHT_Y + row * CLASS_ROW_HEIGHT + offset, HIGHLIGHT_COLOR)
    }
  }
  return { image: { data, width: SCREEN_WIDTH, height: SCREEN_HEIGHT }, square, highlight }
}
