// Colour sampling from the face photo, around MediaPipe face landmarks. Runs on the worker's in-memory pixels; only the
// resulting colours (and a few hair-coverage numbers) leave this module.

export interface RgbaImage {
  width: number
  height: number
  data: Uint8ClampedArray | Uint8Array
}

export type Rgb = [number, number, number]

export function srgbToLinear(value: number): number {
  const c = value / 255
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

export function linearToSrgb(value: number): number {
  const v = Math.min(Math.max(value, 0), 1)
  return Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255)
}

function labCurve(t: number): number {
  return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116
}

export function toLab(color: Rgb): Rgb {
  const [r, g, b] = color.map(srgbToLinear) as Rgb
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883
  const f = labCurve
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))]
}

/** CIE76 colour difference. */
export function deltaE(a: Rgb, b: Rgb): number {
  const la = toLab(a)
  const lb = toLab(b)
  return Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2])
}

export function hex(color: Rgb): `#${string}` {
  return `#${color.map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`
}

type Point = [number, number]

function pixel(image: RgbaImage, x: number, y: number): Rgb | null {
  const px = Math.round(x)
  const py = Math.round(y)
  if (px < 0 || py < 0 || px >= image.width || py >= image.height) return null
  const offset = (py * image.width + px) * 4
  return [image.data[offset] ?? 0, image.data[offset + 1] ?? 0, image.data[offset + 2] ?? 0]
}

function luminance(color: Rgb): number {
  return 0.2126 * srgbToLinear(color[0]) + 0.7152 * srgbToLinear(color[1]) + 0.0722 * srgbToLinear(color[2])
}

/** Per-channel median in linear light of the samples whose luminance falls between the given quantiles. */
export function robustColor(samples: Rgb[], low = 0.2, high = 0.8): Rgb | null {
  if (samples.length === 0) return null
  const sorted = [...samples].toSorted((a, b) => luminance(a) - luminance(b))
  const kept = sorted.slice(
    Math.floor(sorted.length * low),
    Math.max(Math.ceil(sorted.length * high), Math.floor(sorted.length * low) + 1),
  )
  return [0, 1, 2].map((channel) => {
    const values = kept.map((color) => srgbToLinear(color[channel] ?? 0)).toSorted((a, b) => a - b)
    return linearToSrgb(values[values.length >> 1] ?? 0)
  }) as Rgb
}

function disk(image: RgbaImage, centre: Point, radius: number): Rgb[] {
  const samples: Rgb[] = []
  const r = Math.max(radius, 1)
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r) continue
      const color = pixel(image, centre[0] + dx, centre[1] + dy)
      if (color) samples.push(color)
    }
  return samples
}

/** MediaPipe Face Mesh indices used for sampling. */
export const faceIndex = {
  foreheadTop: 10,
  foreheadMid: 151,
  chin: 152,
  lowerLip: 17,
  noseTip: 4,
  faceLeft: 234,
  faceRight: 454,
  cheeks: [50, 280, 205, 425],
  jaw: [150, 379, 136, 365],
  irisLeft: [468, 469, 470, 471, 472],
  irisRight: [473, 474, 475, 476, 477],
  browUpper: [70, 63, 105, 66, 107, 300, 293, 334, 296, 336],
  browLower: [46, 53, 52, 65, 55, 276, 283, 282, 295, 285],
  eyeLeft: 33,
  eyeRight: 263,
} as const

/** Distance in the a*b* plane only: shading darkens skin (L*) far more than it shifts its hue and chroma. */
export function chromaDistance(a: Rgb, b: Rgb): number {
  const la = toLab(a)
  const lb = toLab(b)
  return Math.hypot(la[1] - lb[1], la[2] - lb[2])
}

export const beardThreshold = 8

export interface FaceColors {
  skin: Rgb
  eyes: Rgb
  brows: Rgb
  hair: Rgb | null
  beard: Rgb | null
  /** How far the lower face's colour is from the skin's, in a*b*: what the beard decision thresholds. */
  beardScore: number
  /** Hair-shape numbers for the hair picker, in face heights (eyes to chin). */
  hairShape: { coverage: number; crown: number; fall: number }
}

export function sampleFaceColors(image: RgbaImage, landmarks: ArrayLike<number>): FaceColors {
  const at = (index: number): Point => [
    (landmarks[index * 3] ?? 0) * image.width,
    (landmarks[index * 3 + 1] ?? 0) * image.height,
  ]
  const faceWidth = Math.hypot(
    at(faceIndex.faceLeft)[0] - at(faceIndex.faceRight)[0],
    at(faceIndex.faceLeft)[1] - at(faceIndex.faceRight)[1],
  )
  const eyeY = (at(faceIndex.eyeLeft)[1] + at(faceIndex.eyeRight)[1]) / 2
  const chin = at(faceIndex.chin)
  const faceHeight = Math.max(chin[1] - eyeY, 1)
  const small = Math.round(faceWidth * 0.035)

  const skinSamples = [faceIndex.foreheadMid, ...faceIndex.cheeks].flatMap((index) => disk(image, at(index), small))
  const skin = robustColor(skinSamples) ?? [200, 160, 130]

  const irisSamples: Rgb[] = []
  for (const iris of [faceIndex.irisLeft, faceIndex.irisRight]) {
    const centre = at(iris[0])
    const radius =
      iris.slice(1).reduce((sum, index) => sum + Math.hypot(at(index)[0] - centre[0], at(index)[1] - centre[1]), 0) / 4
    const r = Math.ceil(radius)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const d = Math.hypot(dx, dy) / Math.max(radius, 1)
        if (d < 0.45 || d > 0.72 || dy < -0.3 * radius) continue
        const color = pixel(image, centre[0] + dx, centre[1] + dy)
        if (color) irisSamples.push(color)
      }
  }
  const eyes = robustColor(irisSamples, 0.1, 0.5) ?? [90, 60, 40]

  const browSamples: Rgb[] = []
  faceIndex.browUpper.forEach((upper, k) => {
    const lower = faceIndex.browLower[k] ?? upper
    const a = at(upper)
    const b = at(lower)
    browSamples.push(...disk(image, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], Math.round(faceWidth * 0.015)))
  })
  const brows = robustColor(browSamples, 0, 0.5) ?? skin

  // Background from the top corners; hair is what is neither background nor skin above the forehead.
  const corner = Math.round(Math.min(image.width, image.height) * 0.03)
  const background = robustColor(
    [...disk(image, [corner, corner], corner), ...disk(image, [image.width - corner, corner], corner)],
    0.1,
    0.9,
  ) ?? [255, 255, 255]
  const isHairLike = (color: Rgb) => deltaE(color, background) > 12 && deltaE(color, skin) > 14
  const top = at(faceIndex.foreheadTop)
  const crownSamples: Rgb[] = []
  let crownTotal = 0
  for (let y = top[1] - faceHeight * 0.45; y < top[1] - faceHeight * 0.05; y += 1)
    for (let x = top[0] - faceWidth * 0.25; x <= top[0] + faceWidth * 0.25; x += 2) {
      const color = pixel(image, x, y)
      if (!color) continue
      crownTotal++
      if (isHairLike(color)) crownSamples.push(color)
    }
  const coverage = crownTotal > 0 ? crownSamples.length / crownTotal : 0
  const hair = coverage > 0.15 ? robustColor(crownSamples, 0.1, 0.9) : null

  // Crown: how far hair-coloured pixels rise above the forehead's top landmark, in face heights.
  let crown = 0
  let fall = 0
  if (hair) {
    const near = (color: Rgb) => deltaE(color, hair) < 16
    for (let y = Math.round(top[1]); y > 0; y--) {
      let hits = 0
      let count = 0
      for (let x = top[0] - faceWidth * 0.1; x <= top[0] + faceWidth * 0.1; x += 1) {
        const color = pixel(image, x, y)
        if (!color) continue
        count++
        if (near(color)) hits++
      }
      if (count > 0 && hits / count > 0.5) crown = (top[1] - y) / faceHeight
    }
    // Fall: the lowest row where hair shows beside the face, below the eyes.
    for (const side of [-1, 1]) {
      const edge = at(side < 0 ? faceIndex.faceLeft : faceIndex.faceRight)
      for (let y = Math.round(eyeY); y < image.height; y++) {
        let hits = 0
        let count = 0
        for (let k = 0.02; k <= 0.3; k += 0.02) {
          const color = pixel(image, edge[0] + side * k * faceWidth, y)
          if (!color) continue
          count++
          if (near(color)) hits++
        }
        if (count > 0 && hits / count > 0.3) fall = Math.max(fall, (y - eyeY) / faceHeight)
      }
    }
  }

  const lowerLip = at(faceIndex.lowerLip)
  const beardSamples = [
    ...disk(image, [(lowerLip[0] + chin[0]) / 2, (lowerLip[1] + chin[1]) / 2], small),
    ...faceIndex.jaw.flatMap((index) => disk(image, at(index), small)),
  ]
  const lowerFace = robustColor(beardSamples) ?? skin
  const beardScore = chromaDistance(lowerFace, skin)
  const beard = beardScore > beardThreshold && luminance(lowerFace) < luminance(skin) ? lowerFace : null

  return { skin, eyes, brows, hair, beard, beardScore, hairShape: { coverage, crown, fall } }
}
