// Paint regions of the head (lips, brows, scalp, beard) on Anny's mesh. They colour the stylised character, and the
// synthetic generator paints its ground-truth people with them. Defined from the facial-action targets and the eye
// bones, so they follow any body or face shape.

import type { AnnyModel } from "./anny.ts"

export const Region = {
  skin: 0,
  lips: 1,
  brows: 2,
  scalp: 3,
  beard: 4,
  /** Anny's low-poly eyeballs: the stylised character replaces them with its own eyes. */
  eyeball: 5,
  mouthInside: 6,
} as const
export type RegionId = (typeof Region)[keyof typeof Region]

function targetMagnitudes(model: AnnyModel, name: string): Float32Array {
  const index = model.facialActionLabels.indexOf(name)
  const subset = model.headSubset
  const out = new Float32Array(model.vertexCount)
  if (index < 0) return out
  const base = index * subset.length * 3
  for (let local = 0; local < subset.length; local++) {
    const x = model.facialActions[base + local * 3] ?? 0
    const y = model.facialActions[base + local * 3 + 1] ?? 0
    const z = model.facialActions[base + local * 3 + 2] ?? 0
    out[subset[local] ?? 0] = Math.hypot(x, y, z)
  }
  return out
}

function maxOf(values: Float32Array): number {
  let best = 0
  for (const value of values) best = Math.max(best, value)
  return best
}

/**
 * Anny's mesh is the body plus three small closed parts: the mouth cavity and the two low-poly eyeballs. Returns the
 * part of each vertex: 0 body, 1 mouth inside, 2 left eye, 3 right eye.
 */
export function meshParts(model: AnnyModel, vertices: Float32Array): Uint8Array {
  const parent = Int32Array.from({ length: model.vertexCount }, (_, index) => index)
  const find = (start: number): number => {
    let node = start
    while (parent[node] !== node) {
      parent[node] = parent[parent[node] ?? node] ?? node
      node = parent[node] ?? node
    }
    return node
  }
  const faces = model.faces
  for (let t = 0; t < faces.length; t += 3) {
    const a = find(faces[t] ?? 0)
    parent[find(faces[t + 1] ?? 0)] = a
    parent[find(faces[t + 2] ?? 0)] = a
  }
  const sizes = new Map<number, number>()
  const sumX = new Map<number, number>()
  for (let v = 0; v < model.vertexCount; v++) {
    const root = find(v)
    sizes.set(root, (sizes.get(root) ?? 0) + 1)
    sumX.set(root, (sumX.get(root) ?? 0) + (vertices[v * 3] ?? 0))
  }
  const largest = [...sizes.entries()].reduce((best, current) => (current[1] > best[1] ? current : best))[0]
  const parts = new Uint8Array(model.vertexCount)
  for (let v = 0; v < model.vertexCount; v++) {
    const root = find(v)
    if (root === largest) continue
    const meanX = (sumX.get(root) ?? 0) / (sizes.get(root) ?? 1)
    parts[v] = Math.abs(meanX) < 0.005 ? 1 : meanX > 0 ? 2 : 3
  }
  return parts
}

export interface HeadFrame {
  /** Midpoint between the eye centres. */
  eyeMid: [number, number, number]
  /** Distance between the eye centres, the unit the regions scale with. */
  eyeDistance: number
  eyeLeft: [number, number, number]
  eyeRight: [number, number, number]
  /** Radius of Anny's eyeballs. */
  eyeRadius: number
}

export function headFrame(
  model: AnnyModel,
  bones: Float32Array,
  vertices?: Float32Array,
  parts?: Uint8Array,
): HeadFrame {
  const point = (name: string): [number, number, number] => {
    const bone = model.boneLabels.indexOf(name)
    return [bones[bone * 3] ?? 0, bones[bone * 3 + 1] ?? 0, bones[bone * 3 + 2] ?? 0]
  }
  const eyeLeft = point("eye.L")
  const eyeRight = point("eye.R")
  let radius = 0
  let samples = 0
  if (vertices && parts)
    for (let v = 0; v < model.vertexCount; v++) {
      if ((parts[v] ?? 0) < 2) continue
      const x = vertices[v * 3] ?? 0
      const centre = Math.abs(x - eyeLeft[0]) < Math.abs(x - eyeRight[0]) ? eyeLeft : eyeRight
      radius += Math.hypot(
        x - centre[0],
        (vertices[v * 3 + 1] ?? 0) - centre[1],
        (vertices[v * 3 + 2] ?? 0) - centre[2],
      )
      samples++
    }
  const eyeDistance = Math.hypot(eyeLeft[0] - eyeRight[0], eyeLeft[1] - eyeRight[1], eyeLeft[2] - eyeRight[2])
  return {
    eyeRadius: samples > 0 ? radius / samples : eyeDistance * 0.26,
    eyeLeft,
    eyeRight,
    eyeMid: [(eyeLeft[0] + eyeRight[0]) / 2, (eyeLeft[1] + eyeRight[1]) / 2, (eyeLeft[2] + eyeRight[2]) / 2],
    eyeDistance,
  }
}

/**
 * Region of each vertex for the given rest shape. Lips come from the lip-roll targets (they move the lips and little
 * else); brows, scalp and beard are bands in the head frame, measured in eye distances so they scale with the face.
 */
export function paintRegions(
  model: AnnyModel,
  vertices: Float32Array,
  normals: Float32Array,
  frame: HeadFrame,
  parts: Uint8Array,
): Uint8Array {
  const regions = new Uint8Array(model.vertexCount)
  for (let v = 0; v < model.vertexCount; v++)
    if (parts[v] === 1) regions[v] = Region.mouthInside
    else if (parts[v] !== 0) regions[v] = Region.eyeball
  const rollUpper = targetMagnitudes(model, "mouthRollUpper")
  const upperMax = maxOf(rollUpper)
  const [mx, my, mz] = frame.eyeMid
  const d = frame.eyeDistance
  // Upper lip from its roll target; the lower lip's target also moves the chin crease, so the lower lip is an ellipse
  // under the mouth line, as wide as the upper lip.
  let mouthLine = Number.POSITIVE_INFINITY
  let halfWidth = 0
  let mouthY = 0
  let lipCount = 0
  for (let v = 0; v < model.vertexCount; v++) {
    if (regions[v] !== Region.skin) continue
    const x = (vertices[v * 3] ?? 0) - mx
    const y = vertices[v * 3 + 1] ?? 0
    const z = vertices[v * 3 + 2] ?? 0
    if ((rollUpper[v] ?? 0) > 0.45 * upperMax && z > mz - 0.2 * d && y < my - 0.8 * d) {
      regions[v] = Region.lips
      if (Math.abs(x) < 0.2 * d) mouthLine = Math.min(mouthLine, y)
      halfWidth = Math.max(halfWidth, Math.abs(x))
      mouthY += y
      lipCount++
    }
  }
  if (lipCount > 0) {
    mouthY /= lipCount
    const centre = mouthLine - 0.11 * d
    for (let v = 0; v < model.vertexCount; v++) {
      if (regions[v] !== Region.skin) continue
      const x = (vertices[v * 3] ?? 0) - mx
      const y = vertices[v * 3 + 1] ?? 0
      const z = vertices[v * 3 + 2] ?? 0
      const t = (y - centre) / (0.12 * d)
      if (y > mouthLine || Math.abs(t) > 1 || z < mz - 0.2 * d || (normals[v * 3 + 2] ?? 0) < 0.2) continue
      if (Math.abs(x) < halfWidth * 0.9 * Math.sqrt(1 - t * t)) regions[v] = Region.lips
    }
  } else mouthY = my - 1.4 * d
  for (let v = 0; v < model.vertexCount; v++) {
    if (regions[v] !== Region.skin) continue
    const x = (vertices[v * 3] ?? 0) - mx
    const y = (vertices[v * 3 + 1] ?? 0) - my
    const z = (vertices[v * 3 + 2] ?? 0) - mz
    const ny = normals[v * 3 + 1] ?? 0
    const nz = normals[v * 3 + 2] ?? 0
    const ax = Math.abs(x) / d
    const above = y / d
    const front = z / d
    if (above < -2.6 || Math.abs(x) > 1.8 * d) continue
    // Brows: an arc above each eye, highest a little outside the eye centre, thinning towards the temple.
    const fromEye = ax - 0.5
    const arc = 0.36 + 0.05 * Math.cos(Math.min(Math.abs(fromEye - 0.05) * 4.2, Math.PI)) - 0.04 * Math.max(fromEye, 0)
    const thickness = 0.1 - 0.05 * Math.max(fromEye / 0.42, 0)
    if (Math.abs(fromEye) < 0.42 && nz > 0.3 && front > -0.1 && Math.abs(above - arc) < thickness) {
      regions[v] = Region.brows
      continue
    }
    // Scalp: above the hairline at the front, which recedes at the temples, and down to the nape at the back.
    const hairline = 1.05 - 0.25 * Math.min(Math.max(ax - 0.45, 0) / 0.6, 1)
    const back = front < -0.9
    const side = ax > 1.05 && front < -0.15 && above > 0.05
    if (above > hairline || (back && above > -0.35) || side) {
      regions[v] = Region.scalp
      continue
    }
    // Beard: lower face below the nose, along the jaw to the sideburns; surfaces facing down (under the chin) are neck.
    const belowNose = y < mouthY - my + 0.32 * d
    const jaw = above < -0.2 && above > -1.7 && ax > 0.75 && front > -0.75 && ax < 1.25
    const aboveChin = y > mouthY - my - 0.95 * d
    if ((belowNose || jaw) && aboveChin && ny > -0.55 && front > -0.75) regions[v] = Region.beard
  }
  return regions
}
