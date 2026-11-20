// Stylised proportions on top of the fitted shape, behind one `stylize` amount (0 keeps the fit, 1 is the strongest
// look). Kept tasteful so the person stays recognisable: a larger head, larger eyes, a slightly smaller nose and mouth.
// The face part goes through the face modifiers (so it stays a morph-target weight); the head scale is a smooth
// deformation of the vertices and bones above the neck.

import type { AnnyModel } from "./anny.ts"

/** Face modifier offsets at stylize = 1, added to the fitted values (then clamped to [-1, 1]). */
const faceOffsets: Record<string, number> = {
  "eye-scale": 0.6,
  "eye-height2": 0.35,
  "nose-scale-horiz": -0.35,
  "nose-scale-vert": -0.3,
  "nose-point-width": -0.3,
  "mouth-scale-horiz": -0.2,
  "chin-width": -0.25,
  "head-fat": -0.15,
}

/** Head grows by this share at stylize = 1. */
const headGrowth = 0.16
/** Eye regions grow by this share at stylize = 1, on top of the head. */
const eyeOpening = 0.42

export function stylizeFace(model: AnnyModel, face: ArrayLike<number>, amount: number): Float32Array {
  const out = Float32Array.from(model.faceModifierLabels, (_, index) => face[index] ?? 0)
  model.faceModifierLabels.forEach((label, index) => {
    const offset = faceOffsets[label]
    if (offset !== undefined) out[index] = Math.min(Math.max((out[index] ?? 0) + offset * amount, -1), 1)
  })
  return out
}

/** The head-scale deformation, as a function of a point: shared by the mesh, the bones and the eyes. */
export function headScaler(
  model: AnnyModel,
  bones: Float32Array,
  amount: number,
): (x: number, y: number, z: number) => [number, number, number] {
  const point = (name: string) => {
    const bone = model.boneLabels.indexOf(name)
    return [bones[bone * 3] ?? 0, bones[bone * 3 + 1] ?? 0, bones[bone * 3 + 2] ?? 0] as const
  }
  const pivot = point("head")
  const neck = point("neck02")
  const eyes = [point("eye.L"), point("eye.R")]
  const eyeDistance = Math.hypot((eyes[0]?.[0] ?? 0) - (eyes[1]?.[0] ?? 0), (eyes[0]?.[1] ?? 0) - (eyes[1]?.[1] ?? 0))
  const growth = headGrowth * amount
  const eyeGrowth = eyeOpening * amount
  const low = neck[1]
  const high = pivot[1]
  return (x0, y0, z0) => {
    let x = x0
    let y = y0
    let z = z0
    // Each eye region grows about its eye centre (less in depth), so lids open with the larger eyeball.
    for (const eye of eyes) {
      if (!eye || eyeGrowth === 0) continue
      const r = Math.hypot(x - eye[0], y - eye[1], (z - eye[2]) * 0.6) / eyeDistance
      const t = 1 - Math.min(Math.max((r - 0.18) / 0.32, 0), 1)
      if (t <= 0) continue
      const k = eyeGrowth * t * t * (3 - 2 * t)
      // Taller more than wider: toon eyes are rounder than the almond they start from.
      x += (x - eye[0]) * k
      y += (y - eye[1]) * k * 1.5
      z += (z - eye[2]) * k * 0.4
    }
    if (growth === 0 || y <= low) return [x, y, z]
    const t = Math.min((y - low) / Math.max(high - low, 1e-6), 1)
    const scale = 1 + growth * t * t * (3 - 2 * t)
    return [pivot[0] + (x - pivot[0]) * scale, pivot[1] + (y - pivot[1]) * scale, pivot[2] + (z - pivot[2]) * scale]
  }
}

export function applyToPoints(
  points: Float32Array,
  transform: (x: number, y: number, z: number) => [number, number, number],
): Float32Array {
  const out = new Float32Array(points.length)
  for (let index = 0; index < points.length; index += 3) {
    const [x, y, z] = transform(points[index] ?? 0, points[index + 1] ?? 0, points[index + 2] ?? 0)
    out[index] = x
    out[index + 1] = y
    out[index + 2] = z
  }
  return out
}
