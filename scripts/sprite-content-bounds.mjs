import sharp from 'sharp'

export async function visibleContentBounds(bytes) {
  const image = sharp(bytes)
  const metadata = await image.metadata()
  if (metadata.pages !== undefined && metadata.pages !== 1) throw new Error('Artwork must contain exactly one image frame')
  const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let minX = info.width
  let maxX = -1
  let minY = info.height
  let maxY = -1
  for (let y = 0; y < info.height; y += 1) for (let x = 0; x < info.width; x += 1) {
    if (data[(y * info.width + x) * info.channels + 3] === 0) continue
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }
  if (maxX < 0 || maxY < 0) throw new Error('Artwork has no visible pixels')
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

export function validateContentBounds(bounds, asset) {
  if (!bounds || !['x', 'y', 'width', 'height'].every(key => Number.isInteger(bounds[key]))) throw new Error('Invalid artwork content bounds')
  if (bounds.x < 0 || bounds.y < 0 || bounds.width < 1 || bounds.height < 1 || bounds.x + bounds.width > asset.width || bounds.y + bounds.height > asset.height) throw new Error('Artwork content bounds escape the image')
}
