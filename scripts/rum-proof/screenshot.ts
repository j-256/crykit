import type { Page } from '@playwright/test'

// Reproduce the supported Learn screenshot layout with only synthetic pixels/text
// The app must create its own object URL through the real import path
export async function privateScreenshot(page: Page, privateText: string): Promise<{ bytes: Buffer; dataPrefix: string }> {
  const url = await page.evaluate(privateText => {
    const image = document.createElement('canvas')
    image.width = 1280
    image.height = 720
    const context = image.getContext('2d')!
    context.fillStyle = '#1f252b'
    context.fillRect(0, 0, image.width, image.height)
    context.fillStyle = '#fafafa'
    context.font = '20px Arial'
    context.fillText('Learn', 134, 110)
    context.fillText('Rowan', 490, 60)
    context.fillText('Practice class', 305, 229)
    context.fillText(privateText, 750, 60)
    context.fillRect(624, 211, 1, 18)
    for (const [row, column, color] of [[0, 0, '#c0bb28'], [0, 1, '#2096d4'], [1, 0, '#425059'], [1, 1, '#c0bb28']] as const) {
      const x = 670 + column * 64, y = 222 + row * 64
      context.fillStyle = color
      context.fillRect(x, y, 40, 1)
      context.fillRect(x, y, 1, 40)
      context.fillRect(x + 39, y, 1, 40)
      context.fillRect(x, y + 39, 40, 1)
    }
    context.fillStyle = '#2096d4'
    context.fillRect(734, 293, 1, 24)
    return image.toDataURL('image/png')
  }, privateText)
  return { bytes: Buffer.from(url.split(',')[1], 'base64'), dataPrefix: url.slice(0, 100) }
}
