// Visual style presets. A preset is data: the GLB carries it in its materials' `extras.eskais`, the reference three.js
// materials (`eskais-character/three`) and the repo's software renderer both read the same numbers, so a style looks
// the same wherever it is drawn.

export const styleIds = ["soft-toon", "cel-outline", "low-poly", "clay"] as const
export type StyleId = (typeof styleIds)[number]

export interface StylePreset {
  id: StyleId
  label: string
  /** Light ramp: `levels[i]` is the brightness for diffuse light above `steps[i]`; `softness` blurs each step. */
  ramp: { steps: number[]; levels: number[]; softness: number }
  /** Inverted-hull outline, width in metres (0 for none), linear RGB colour. */
  outline: { width: number; color: [number, number, number] }
  /** Rim light added at grazing angles: strength and falloff exponent. */
  rim: { strength: number; power: number }
  /** Faceted shading from face normals. */
  flatShading: boolean
  /** 1 keeps colours, 0 greys them; clay also pulls everything towards `tint`. */
  saturation: number
  tint: [number, number, number] | null
  tintAmount: number
  /** Hair highlight strength (skin and eyes get none: on skin a highlight reads as a wet patch). */
  specular: number
}

const ink: [number, number, number] = [0.025, 0.02, 0.03]

export const stylePresets: Record<StyleId, StylePreset> = {
  "soft-toon": {
    id: "soft-toon",
    label: "Soft toon",
    ramp: { steps: [0.15, 0.55], levels: [0.55, 0.82, 1], softness: 0.12 },
    outline: { width: 0.0025, color: ink },
    rim: { strength: 0.22, power: 3 },
    flatShading: false,
    saturation: 1.05,
    tint: null,
    tintAmount: 0,
    specular: 0.05,
  },
  "cel-outline": {
    id: "cel-outline",
    label: "Cel with outline",
    ramp: { steps: [0.35], levels: [0.62, 1], softness: 0.02 },
    outline: { width: 0.0045, color: ink },
    rim: { strength: 0.12, power: 4 },
    flatShading: false,
    saturation: 1.15,
    tint: null,
    tintAmount: 0,
    specular: 0,
  },
  "low-poly": {
    id: "low-poly",
    label: "Low-poly",
    ramp: { steps: [0.2, 0.5, 0.8], levels: [0.5, 0.68, 0.86, 1], softness: 0 },
    outline: { width: 0, color: ink },
    rim: { strength: 0.08, power: 2 },
    flatShading: true,
    saturation: 1,
    tint: null,
    tintAmount: 0,
    specular: 0,
  },
  clay: {
    id: "clay",
    label: "Clay",
    ramp: { steps: [0.05, 0.4, 0.75], levels: [0.45, 0.66, 0.85, 1], softness: 0.25 },
    outline: { width: 0, color: ink },
    rim: { strength: 0.3, power: 2.5 },
    flatShading: false,
    saturation: 0.55,
    tint: [0.78, 0.56, 0.42],
    tintAmount: 0.25,
    specular: 0.02,
  },
}

export function stylePreset(id: string): StylePreset {
  const preset = (stylePresets as Partial<Record<string, StylePreset>>)[id]
  if (!preset) throw new Error(`Unknown style "${id}".`)
  return preset
}

/** Brightness for a Lambert term under a preset's ramp. */
export function rampLevel(preset: StylePreset, lambert: number): number {
  const { steps, levels, softness } = preset.ramp
  let level = levels[0] ?? 1
  steps.forEach((step, index) => {
    const next = levels[index + 1] ?? level
    const previous = levels[index] ?? level
    const t = softness <= 0 ? (lambert >= step ? 1 : 0) : smoothstep(step - softness / 2, step + softness / 2, lambert)
    if (t > 0) level = previous + (next - previous) * t
  })
  return level
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1)
  return t * t * (3 - 2 * t)
}

/** A preset's colour treatment on a linear RGB colour (saturation, then the clay tint). */
export function styleColor(preset: StylePreset, color: ArrayLike<number>): [number, number, number] {
  const r = color[0] ?? 0
  const g = color[1] ?? 0
  const b = color[2] ?? 0
  const grey = 0.2126 * r + 0.7152 * g + 0.0722 * b
  const saturated = [r, g, b].map((channel) => Math.max(0, grey + (channel - grey) * preset.saturation)) as [
    number,
    number,
    number,
  ]
  const tint = preset.tint
  if (!tint) return saturated
  return saturated.map(
    (channel, index) => channel + ((tint[index] ?? 0) * grey * 2.2 - channel) * preset.tintAmount,
  ) as [number, number, number]
}
