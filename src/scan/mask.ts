// The person mask the UI uses for its photo-to-character transition: MediaPipe's segmentation confidence, box-filtered
// down to at most 256 px on the long side so it stays small to post. It keeps the photo's aspect ratio.
import type { PersonMask } from "./detect.ts"

export const maskLongSide = 256

export function downsampleMask(mask: PersonMask, longSide = maskLongSide): PersonMask {
  const scale = Math.min(1, longSide / Math.max(mask.width, mask.height))
  const width = Math.max(1, Math.round(mask.width * scale))
  const height = Math.max(1, Math.round(mask.height * scale))
  const data = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor((y * mask.height) / height)
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * mask.height) / height))
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor((x * mask.width) / width)
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * mask.width) / width))
      let sum = 0
      for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) sum += mask.data[sy * mask.width + sx] ?? 0
      data[y * width + x] = Math.round(sum / ((y1 - y0) * (x1 - x0)))
    }
  }
  return { width, height, data }
}
