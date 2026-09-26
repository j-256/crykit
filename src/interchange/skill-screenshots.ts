import { MAX_SKILL_CAPTURES } from '../domain/skill-trees'
import type { SkillSquare } from '../domain/types'
import { detectSkillGrid, SCREEN_HEIGHT, SCREEN_WIDTH } from './skill-grid'
import { imageDimensions } from './image-dimensions'

export const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024
export const MAX_SCREENSHOT_BATCH_BYTES = 64 * 1024 * 1024
const MAX_SCREENSHOT_PIXELS = 16 * 1024 * 1024
const MIN_SCREENSHOT_WIDTH = 960

export interface ScreenshotPreview {
  readonly id: string
  readonly filename: string
  readonly imageUrl?: string
  readonly digest?: string
  readonly characterName?: string
  readonly className?: string
  readonly squares: readonly SkillSquare[]
  readonly duplicateOf?: string
  readonly error?: string
}

function canvas(width: number, height: number): HTMLCanvasElement {
  const result = document.createElement('canvas')
  result.width = width
  result.height = height
  return result
}

function context(image: HTMLCanvasElement): CanvasRenderingContext2D {
  const result = image.getContext('2d', { willReadFrequently: true })
  if (!result) throw new Error('This browser cannot read screenshot pixels')
  return result
}

async function fingerprint(data: Uint8ClampedArray): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(data))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function validateScreenshotBatch(files: readonly File[]): void {
  if (!files.length || files.length > MAX_SKILL_CAPTURES) throw new Error(`Choose between 1 and ${MAX_SKILL_CAPTURES} screenshots`)
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_SCREENSHOT_BATCH_BYTES) throw new Error('The screenshot batch exceeds 64 MiB. Choose a smaller batch')
}

async function decodeScreenshot(file: File): Promise<{ image: HTMLCanvasElement; digest: string }> {
  if (!file.size || file.size > MAX_SCREENSHOT_BYTES) throw new Error('Choose a nonempty PNG or JPEG smaller than 8 MiB')
  const dimensions = imageDimensions(new Uint8Array(await file.arrayBuffer()))
  if (!dimensions.height || dimensions.width < MIN_SCREENSHOT_WIDTH || dimensions.width * dimensions.height > MAX_SCREENSHOT_PIXELS || Math.abs(dimensions.width / dimensions.height - SCREEN_WIDTH / SCREEN_HEIGHT) > 0.01) throw new Error('Use a full, uncropped 16:9 Learn screenshot, at least 960 pixels wide and at most 16 megapixels')
  const url = URL.createObjectURL(file)
  try {
    const source = new Image()
    source.src = url
    await source.decode()
    if (source.width < MIN_SCREENSHOT_WIDTH || source.width * source.height > MAX_SCREENSHOT_PIXELS || Math.abs(source.width / source.height - SCREEN_WIDTH / SCREEN_HEIGHT) > 0.01) throw new Error('Use a full, uncropped 16:9 Learn screenshot, at least 960 pixels wide and at most 16 megapixels')
    const original = canvas(source.width, source.height)
    context(original).drawImage(source, 0, 0)
    const digest = await fingerprint(context(original).getImageData(0, 0, original.width, original.height).data)
    original.width = 0
    original.height = 0
    const image = canvas(SCREEN_WIDTH, SCREEN_HEIGHT)
    context(image).drawImage(source, 0, 0, image.width, image.height)
    return { image, digest }
  } finally { URL.revokeObjectURL(url) }
}

function textCrop(image: HTMLCanvasElement, x: number, y: number, width: number, height: number): HTMLCanvasElement {
  const result = canvas(width * 3, height * 3)
  const ctx = context(result)
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(image, x, y, width, height, 0, 0, result.width, result.height)
  const pixels = ctx.getImageData(0, 0, result.width, result.height)
  for (let i = 0; i < pixels.data.length; i += 4) {
    const [r, g, b] = [pixels.data[i], pixels.data[i + 1], pixels.data[i + 2]]
    const whiteText = Math.min(r, g, b) > 145 && Math.max(r, g, b) - Math.min(r, g, b) < 75
    pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = whiteText ? 0 : 255
  }
  ctx.putImageData(pixels, 0, 0)
  return result
}

export async function previewSkillScreenshots(files: readonly File[], onProgress: (completed: number, total: number) => void, signal?: AbortSignal): Promise<readonly ScreenshotPreview[]> {
  validateScreenshotBatch(files)
  const previews: ScreenshotPreview[] = []
  const seen = new Map<string, string>()
  let worker: import('tesseract.js').Worker | undefined
  const abort = () => { void worker?.terminate() }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    for (const [index, file] of files.entries()) {
      signal?.throwIfAborted()
      const id = `screenshot-${index}`
      let decodedImage: HTMLCanvasElement | undefined
      try {
        const decoded = await decodeScreenshot(file)
        decodedImage = decoded.image
        const duplicateOf = seen.get(decoded.digest)
        if (duplicateOf) {
          previews.push({ id, filename: file.name, digest: decoded.digest, squares: [], duplicateOf })
          continue
        }
        seen.set(decoded.digest, file.name)
        const grid = detectSkillGrid(context(decoded.image).getImageData(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT))
        if (grid.squares.length < 3 || grid.selectedRow === undefined) throw new Error('No supported Learn screen found. Include the character header, selected class row, and full tree')
        if (!worker) {
          const { createWorker, OEM, PSM } = await import('tesseract.js')
          const base = new URL('ocr/', new URL(import.meta.env.BASE_URL, document.baseURI)).href
          worker = await abortable(createWorker('eng', OEM.LSTM_ONLY, { workerPath: `${base}worker.min.js`, corePath: base, langPath: base, workerBlobURL: false, errorHandler: () => undefined }).then(created => {
            if (signal?.aborted) { void created.terminate(); signal.throwIfAborted() }
            worker = created
            return created
          }), signal)
          await worker!.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE })
        }
        signal?.throwIfAborted()
        const readText = async (x: number, y: number, width: number, height: number) => (await abortable(worker!.recognize(textCrop(decoded.image, x, y, width, height)), signal)).data.text.trim()
        const menuName = await readText(127, 90, 130, 25)
        if (!/^learn$/i.test(menuName)) throw new Error('This screenshot is not the Learn menu')
        const characterName = await readText(484, 40, 175, 23)
        const className = await readText(304, 209 + grid.selectedRow * 28, 136, 23)
        previews.push({ id, filename: file.name, digest: decoded.digest, imageUrl: URL.createObjectURL(file), characterName, className, squares: grid.squares })
      } catch (error) {
        signal?.throwIfAborted()
        previews.push({ id, filename: file.name, squares: [], error: error instanceof Error ? error.message : 'The screenshot could not be read' })
      } finally {
        if (decodedImage) { decodedImage.width = 0; decodedImage.height = 0 }
        onProgress(index + 1, files.length)
      }
    }
    return previews
  } catch (error) {
    releaseScreenshotPreviews(previews)
    throw error
  } finally {
    signal?.removeEventListener('abort', abort)
    await worker?.terminate()
  }
}

function abortable<Value>(promise: Promise<Value>, signal?: AbortSignal): Promise<Value> {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Screenshot reading cancelled', 'AbortError'))
    if (signal.aborted) { promise.catch(() => undefined); abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

export function releaseScreenshotPreviews(previews: readonly ScreenshotPreview[]): void {
  for (const preview of previews) if (preview.imageUrl) URL.revokeObjectURL(preview.imageUrl)
}
