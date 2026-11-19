// Synthetic people: Anny bodies with known parameters, painted with known colours. Nothing here comes from a photo.

import { phenotypeLabels, phenotypeRange, type AnnyModel, type Phenotype } from "../../src/model/anny.ts"
import { hairCatalogue } from "../../src/model/hair.ts"

export const generatorVersion = "eskais-synth/1"

export type Rgb = [number, number, number]

export interface Subject {
  id: string
  phenotype: Phenotype
  /** Face modifier values in [-1, 1], keyed by label. */
  face: Record<string, number>
  /** sRGB 0..255. */
  colors: { skin: Rgb; eyes: Rgb; hair: Rgb; brows: Rgb; beard: Rgb | null }
  hair: string
  light: { azimuth: number; elevation: number }
  background: Rgb
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Skin tones from light to deep, spaced evenly; the generator interpolates between neighbours.
const skinRamp: Rgb[] = [
  [246, 222, 204],
  [234, 196, 168],
  [215, 170, 135],
  [190, 140, 105],
  [160, 110, 78],
  [125, 82, 56],
  [92, 58, 40],
  [62, 40, 28],
]
const eyePalette: Rgb[] = [
  [60, 38, 24],
  [92, 60, 34],
  [120, 96, 50],
  [70, 110, 70],
  [70, 110, 160],
  [110, 120, 130],
]
const hairPalette: Rgb[] = [
  [22, 18, 16],
  [50, 34, 24],
  [92, 62, 40],
  [140, 70, 40],
  [196, 160, 100],
  [150, 146, 140],
]

function pick<T>(random: () => number, items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)]
  if (item === undefined) throw new Error("Empty palette.")
  return item
}

function jitter(random: () => number, color: Rgb, amount: number): Rgb {
  return color.map((channel) => Math.round(Math.min(255, Math.max(0, channel + (random() * 2 - 1) * amount)))) as Rgb
}

export function makeSubjects(model: AnnyModel, count: number, seed: number): Subject[] {
  const random = mulberry32(seed)
  const subjects: Subject[] = []
  for (let index = 0; index < count; index++) {
    const phenotype = Object.fromEntries(
      phenotypeLabels.map((label) => {
        const [low, high] = phenotypeRange[label]
        // Keep 5% off the edges: the fit clamps to the range, so the very edges would test the clamp, not the fit.
        return [label, low + (high - low) * (0.05 + 0.9 * random())]
      }),
    ) as Phenotype
    const face: Record<string, number> = {}
    for (const label of model.faceModifierLabels)
      face[label] = random() < 0.6 ? Math.round((random() * 1.2 - 0.6) * 1000) / 1000 : 0
    const tone = random() * (skinRamp.length - 1)
    const low = skinRamp[Math.floor(tone)] ?? skinRamp[0]!
    const high = skinRamp[Math.ceil(tone)] ?? low
    const mix = tone - Math.floor(tone)
    const skin = low.map((channel, k) => Math.round(channel + ((high[k] ?? channel) - channel) * mix)) as Rgb
    const hairColor = jitter(random, pick(random, hairPalette), 8)
    const brows = hairColor.map((channel) => Math.round(channel * 0.8)) as Rgb
    const male = phenotype.gender < 0.4
    const beard = male && random() < 0.45 ? (hairColor.map((channel) => Math.round(channel * 0.9)) as Rgb) : null
    const styles = hairCatalogue.filter((style) => style.id !== "none" || male)
    subjects.push({
      id: `s${String(index).padStart(3, "0")}`,
      phenotype,
      face,
      colors: { skin, eyes: jitter(random, pick(random, eyePalette), 6), hair: hairColor, brows, beard },
      hair: pick(random, styles).id,
      light: { azimuth: (random() * 2 - 1) * 0.5, elevation: 0.35 + random() * 0.4 },
      background: jitter(random, [176, 182, 190], 30),
    })
  }
  return subjects
}
