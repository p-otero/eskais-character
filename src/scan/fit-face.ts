// Face fit: Anny's face modifiers from MediaPipe's 478 landmarks. The landmark map (calibrated on synthetic renders,
// assets/anny/face-landmarks.json) puts each landmark on the mesh, so model landmarks are linear in the modifier
// weights. Alternates a similarity alignment (Umeyama) with a bounded ridge least-squares solve of the weights.

import { evaluateShape, type AnnyModel } from "../model/anny.ts"

export interface FaceLandmarkMap {
  blendshapeBaseline: Record<string, number>
  landmarks: { v: number[]; w: number[]; hits: number; spreadMm: number | null }[]
}

export interface FaceObservation {
  /** 478 × (x, y, z), normalised as MediaPipe returns them. */
  landmarks: ArrayLike<number>
  blendshapes: Record<string, number>
  width: number
  height: number
}

export interface FaceFitOptions {
  /** Ridge weight on the modifier weights (metres² per unit²). */
  lambda?: number
  iterations?: number
  /** Weight of the depth residual relative to x and y: MediaPipe's z is the least reliable axis. */
  depthWeight?: number
  maxSpreadMm?: number
  /** Face values to start from and regularise towards (the learned prior); zero when absent. */
  prior?: ArrayLike<number>
  /** Which modifiers the landmarks may move; the others stay at the prior. Default: all. */
  free?: readonly boolean[]
  onIteration?: (face: Float32Array, iteration: number, iterations: number) => void
}

export interface FaceFit {
  /** Face modifier values in [-1, 1], aligned with model.faceModifierLabels. */
  face: Float32Array
  /** Expression read from the photo (removed from the shape, not kept in the character). */
  expression: Float32Array
  /** RMS landmark residual after the fit, millimetres. */
  rmsMm: number
  landmarkCount: number
}

type Mat3 = [number, number, number, number, number, number, number, number, number]

/** Expression weights from MediaPipe's blendshapes, relative to what it reads on a neutral Anny face. */
export function expressionFromBlendshapes(
  model: AnnyModel,
  map: FaceLandmarkMap,
  blendshapes: Record<string, number>,
): Float32Array {
  return Float32Array.from(model.facialActionLabels, (label) => {
    const baseline = map.blendshapeBaseline[label] ?? 0
    const score = blendshapes[label] ?? 0
    return Math.min(Math.max((score - baseline) / Math.max(1 - baseline, 1e-3), 0), 1)
  })
}

export interface Similarity {
  scale: number
  rotation: Mat3
  translation: [number, number, number]
}

/**
 * Weighted Umeyama: the similarity mapping source points onto target points. The rotation comes from the
 * eigenvectors of the symmetric form of the cross-covariance (Horn's method), which avoids an SVD.
 */
export function similarity(source: Float64Array, target: Float64Array, weights: Float64Array): Similarity {
  const n = weights.length
  let total = 0
  const ms = [0, 0, 0]
  const mt = [0, 0, 0]
  for (let i = 0; i < n; i++) {
    const w = weights[i]!
    total += w
    for (let k = 0; k < 3; k++) {
      ms[k]! += w * source[i * 3 + k]!
      mt[k]! += w * target[i * 3 + k]!
    }
  }
  for (let k = 0; k < 3; k++) {
    ms[k]! /= total
    mt[k]! /= total
  }
  const s = new Float64Array(9)
  let variance = 0
  for (let i = 0; i < n; i++) {
    const w = weights[i]!
    for (let r = 0; r < 3; r++) {
      const a = source[i * 3 + r]! - ms[r]!
      variance += w * a * a
      for (let c = 0; c < 3; c++) s[r * 3 + c]! += w * a * (target[i * 3 + c]! - mt[c]!)
    }
  }
  // Horn's quaternion method: the rotation is the top eigenvector of a symmetric 4×4 built from S.
  const [sxx, sxy, sxz, syx, syy, syz, szx, szy, szz] = Array.from(s) as Mat3
  const k4 = [
    [sxx + syy + szz, syz - szy, szx - sxz, sxy - syx],
    [syz - szy, sxx - syy - szz, sxy + syx, szx + sxz],
    [szx - sxz, sxy + syx, -sxx + syy - szz, syz + szy],
    [sxy - syx, szx + sxz, syz + szy, -sxx - syy + szz],
  ]
  // Power iteration on K + cI (shifted to be positive definite) gives the top eigenvector.
  const shift =
    Math.abs(sxx) +
    Math.abs(syy) +
    Math.abs(szz) +
    Math.abs(sxy) +
    Math.abs(sxz) +
    Math.abs(syz) +
    Math.abs(syx) +
    Math.abs(szx) +
    Math.abs(szy) +
    1e-12
  let q = [1, 0, 0, 0]
  for (let iteration = 0; iteration < 200; iteration++) {
    const next = k4.map((row, r) => row.reduce((sum, value, c) => sum + value * q[c]!, 0) + shift * q[r]!)
    const length = Math.hypot(...next)
    q = next.map((value) => value / length)
  }
  const [w, x, y, z] = q as [number, number, number, number]
  const rotation: Mat3 = [
    1 - 2 * (y * y + z * z),
    2 * (x * y - w * z),
    2 * (x * z + w * y),
    2 * (x * y + w * z),
    1 - 2 * (x * x + z * z),
    2 * (y * z - w * x),
    2 * (x * z - w * y),
    2 * (y * z + w * x),
    1 - 2 * (x * x + y * y),
  ]
  // Rotation maps target-frame covariance: trace(R^T S^T)/variance is the scale.
  let trace = 0
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) trace += rotation[r * 3 + c]! * s[c * 3 + r]!
  const scale = trace / variance
  const translation: [number, number, number] = [0, 0, 0]
  for (let r = 0; r < 3; r++)
    translation[r] =
      mt[r]! - scale * (rotation[r * 3]! * ms[0]! + rotation[r * 3 + 1]! * ms[1]! + rotation[r * 3 + 2]! * ms[2]!)
  return { scale, rotation, translation }
}

/** Projected coordinate descent for min ½uᵀGu − hᵀu with 0 ≤ u ≤ 1. */
export function boxQuadratic(g: Float64Array, h: Float64Array, u: Float64Array, sweeps: number): void {
  const n = h.length
  for (let sweep = 0; sweep < sweeps; sweep++)
    for (let k = 0; k < n; k++) {
      let sum = h[k]!
      for (let j = 0; j < n; j++) if (j !== k) sum -= g[k * n + j]! * u[j]!
      u[k] = Math.min(Math.max(sum / g[k * n + k]!, 0), 1)
    }
}

export function fitFace(
  model: AnnyModel,
  map: FaceLandmarkMap,
  body: ArrayLike<number>,
  observation: FaceObservation,
  options: FaceFitOptions = {},
): FaceFit {
  const lambda = options.lambda ?? 2e-6
  const iterations = options.iterations ?? 8
  const depthWeight = options.depthWeight ?? 0.3
  const maxSpread = options.maxSpreadMm ?? 6
  const expression = expressionFromBlendshapes(model, map, observation.blendshapes)
  const { vertices } = evaluateShape(model, { body, expression })
  const subsetIndex = new Int32Array(model.vertexCount).fill(-1)
  model.headSubset.forEach((vertex, local) => {
    subsetIndex[vertex] = local
  })
  const used = map.landmarks
    .map((entry, index) => ({ ...entry, index }))
    .filter(
      (entry) =>
        entry.spreadMm !== null &&
        entry.spreadMm <= maxSpread &&
        entry.v.length > 0 &&
        entry.index < observation.landmarks.length / 3,
    )
  const n = used.length
  const targets = model.faceModifierLabels.length * 2
  const subsetStride = model.headSubset.length * 3
  const base = new Float64Array(n * 3)
  const jacobian = new Float64Array(n * 3 * targets)
  const weights = new Float64Array(n)
  const observed = new Float64Array(n * 3)
  used.forEach((entry, i) => {
    weights[i] = 1 / ((entry.spreadMm ?? maxSpread) ** 2 + 1)
    entry.v.forEach((vertex, k) => {
      const w = entry.w[k] ?? 0
      for (let axis = 0; axis < 3; axis++) base[i * 3 + axis]! += w * (vertices[vertex * 3 + axis] ?? 0)
      const local = subsetIndex[vertex] ?? -1
      if (local < 0) return
      for (let t = 0; t < targets; t++)
        for (let axis = 0; axis < 3; axis++)
          jacobian[(i * 3 + axis) * targets + t]! += w * (model.faceModifiers[t * subsetStride + local * 3 + axis] ?? 0)
    })
    const x = observation.landmarks[entry.index * 3] ?? 0
    const y = observation.landmarks[entry.index * 3 + 1] ?? 0
    const z = observation.landmarks[entry.index * 3 + 2] ?? 0
    observed[i * 3] = x * observation.width
    observed[i * 3 + 1] = -y * observation.height
    observed[i * 3 + 2] = -z * observation.width
  })
  const u = new Float64Array(targets)
  const centre = new Float64Array(targets)
  if (options.prior)
    for (let m = 0; m < targets / 2; m++) {
      const value = Math.min(Math.max(options.prior[m] ?? 0, -1), 1)
      centre[2 * m] = Math.max(value, 0)
      centre[2 * m + 1] = Math.max(-value, 0)
    }
  u.set(centre)
  const current = new Float64Array(n * 3)
  const face = new Float32Array(model.faceModifierLabels.length)
  const toFace = () => {
    for (let m = 0; m < face.length; m++) face[m] = (u[2 * m] ?? 0) - (u[2 * m + 1] ?? 0)
  }
  let rms = 0
  for (let iteration = 0; iteration < iterations; iteration++) {
    for (let row = 0; row < n * 3; row++) {
      let sum = base[row]!
      for (let t = 0; t < targets; t++) sum += jacobian[row * targets + t]! * u[t]!
      current[row] = sum
    }
    const pose = similarity(current, observed, weights)
    // Observations back in model space: q = Rᵀ(o − t) / s.
    const q = new Float64Array(n * 3)
    for (let i = 0; i < n; i++) {
      const d = [0, 1, 2].map((axis) => observed[i * 3 + axis]! - pose.translation[axis]!)
      for (let axis = 0; axis < 3; axis++)
        q[i * 3 + axis] =
          (pose.rotation[axis]! * d[0]! + pose.rotation[3 + axis]! * d[1]! + pose.rotation[6 + axis]! * d[2]!) /
          pose.scale
    }
    const g = new Float64Array(targets * targets)
    const h = new Float64Array(targets)
    let residual = 0
    let weightTotal = 0
    for (let i = 0; i < n; i++)
      for (let axis = 0; axis < 3; axis++) {
        const row = i * 3 + axis
        const w = weights[i]! * (axis === 2 ? depthWeight : 1)
        const b = q[row]! - base[row]!
        const r = q[row]! - current[row]!
        residual += w * r * r
        weightTotal += w
        for (let a = 0; a < targets; a++) {
          const ja = jacobian[row * targets + a]!
          if (ja === 0) continue
          h[a]! += w * ja * b
          for (let c = 0; c < targets; c++) g[a * targets + c]! += w * ja * jacobian[row * targets + c]!
        }
      }
    rms = Math.sqrt(residual / weightTotal)
    for (let t = 0; t < targets; t++) {
      // A modifier the landmarks can't see is pinned to the prior by an overwhelming ridge.
      const strength = (options.free?.[t >> 1] ?? true) ? lambda : 1e6
      g[t * targets + t]! += strength * weightTotal + 1e-12
      h[t]! += strength * weightTotal * centre[t]!
    }
    boxQuadratic(g, h, u, 30)
    toFace()
    options.onIteration?.(face, iteration, iterations)
  }
  return { face, expression, rmsMm: rms * 1000, landmarkCount: n }
}
