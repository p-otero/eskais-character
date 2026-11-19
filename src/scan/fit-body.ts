// Body fit: Anny's six phenotypes from the measured body features. MediaPipe's joints and the soft person mask don't
// sit exactly where Anny's bones and skin do, so each model feature goes through a per-feature linear calibration
// (assets/anny/body-calibration.json, learned on synthetic people) before it is compared with the photo.

import {
  bodyCoefficients,
  evaluateShape,
  neutralPhenotype,
  phenotypeLabels,
  phenotypeRange,
  type AnnyModel,
  type Phenotype,
} from "../model/anny.ts"
import {
  bodyFeatureNames,
  modelBodyFeatures,
  modelFeatureContext,
  type BodyFeatures,
  type ModelFeatureContext,
} from "./measure-body.ts"

export interface BodyCalibration {
  /** measured ≈ offset + slope × model, per feature; sigma is the residual spread on the calibration set. */
  features: Record<string, { offset: number; slope: number; sigma: number }>
}

export interface BodyFitOptions {
  /** Stature in metres, when known. */
  stature?: number
  /** Prior: phenotype values pull towards the neutral body with this standard deviation. */
  priorSigma?: number
  /** A learned prior to start from and regularise towards, instead of the neutral body. */
  prior?: { mean: ArrayLike<number>; sigma: ArrayLike<number> }
  iterations?: number
  onIteration?: (phenotype: Phenotype, iteration: number, iterations: number) => void
}

export interface BodyFit {
  phenotype: Phenotype
  /** Normalised residual (RMS of the per-feature z-scores) after the fit. */
  residual: number
  stature: number
  evaluations: number
}

export function statureOf(vertices: Float32Array): number {
  let top = Number.NEGATIVE_INFINITY
  let bottom = Number.POSITIVE_INFINITY
  for (let v = 1; v < vertices.length; v += 3) {
    top = Math.max(top, vertices[v] ?? 0)
    bottom = Math.min(bottom, vertices[v] ?? 0)
  }
  return top - bottom
}

export function createBodyFeatureModel(model: AnnyModel) {
  let context: ModelFeatureContext | undefined
  const buffer = new Float32Array(model.vertexCount * 3)
  return (phenotype: Phenotype): { features: BodyFeatures; stature: number } => {
    const { vertices, bones } = evaluateShape(model, { body: bodyCoefficients(model, phenotype) }, buffer)
    context ??= modelFeatureContext(model, vertices)
    return { features: modelBodyFeatures(context, vertices, bones), stature: statureOf(vertices) }
  }
}

function cost(residuals: number[]): number {
  return residuals.reduce((sum, value) => sum + value * value, 0)
}

function toVector(phenotype: Phenotype): number[] {
  return phenotypeLabels.map((label) => phenotype[label])
}

function toPhenotype(values: number[]): Phenotype {
  return Object.fromEntries(
    phenotypeLabels.map((label, index) => {
      const [low, high] = phenotypeRange[label]
      return [label, Math.min(Math.max(values[index] ?? 0.5, low), high)]
    }),
  ) as Phenotype
}

/** Solves the small dense system (A + μ diag(A)) x = b by Gaussian elimination with partial pivoting. */
function solve(a: number[][], b: number[]): number[] {
  const n = b.length
  const m = a.map((row, i) => [...row, b[i] ?? 0])
  for (let column = 0; column < n; column++) {
    let pivot = column
    for (let row = column + 1; row < n; row++)
      if (Math.abs(m[row]![column]!) > Math.abs(m[pivot]![column]!)) pivot = row
    ;[m[column], m[pivot]] = [m[pivot]!, m[column]!]
    const p = m[column]![column]!
    if (Math.abs(p) < 1e-14) continue
    for (let row = column + 1; row < n; row++) {
      const factor = m[row]![column]! / p
      for (let k = column; k <= n; k++) m[row]![k]! -= factor * m[column]![k]!
    }
  }
  const x = Array.from({ length: n }, () => 0)
  for (let row = n - 1; row >= 0; row--) {
    let sum = m[row]![n]!
    for (let k = row + 1; k < n; k++) sum -= m[row]![k]! * x[k]!
    x[row] = Math.abs(m[row]![row]!) < 1e-14 ? 0 : sum / m[row]![row]!
  }
  return x
}

export function fitBody(
  model: AnnyModel,
  calibration: BodyCalibration,
  measured: BodyFeatures,
  options: BodyFitOptions = {},
  featureModel = createBodyFeatureModel(model),
): BodyFit {
  const iterations = options.iterations ?? 15
  const priorSigma = options.priorSigma ?? 0.35
  const prior = options.prior ? toVector(toPhenotype(Array.from(options.prior.mean))) : toVector(neutralPhenotype)
  const sigmas = prior.map((_, index) =>
    options.prior ? Math.max(options.prior.sigma[index] ?? priorSigma, 0.03) : priorSigma,
  )
  let evaluations = 0
  const residuals = (values: number[]): { r: number[]; stature: number } => {
    evaluations++
    const { features, stature } = featureModel(toPhenotype(values))
    const r: number[] = []
    for (const name of bodyFeatureNames) {
      const c = calibration.features[name]
      if (!c) continue
      r.push((c.offset + c.slope * features[name] - measured[name]) / c.sigma)
    }
    values.forEach((value, index) => r.push((value - (prior[index] ?? 0.5)) / (sigmas[index] ?? priorSigma)))
    if (options.stature !== undefined) r.push((stature - options.stature) / 0.01)
    return { r, stature }
  }
  let x = [...prior]
  let current = residuals(x)
  let mu = 1e-2
  const step = 1e-3
  for (let iteration = 0; iteration < iterations; iteration++) {
    const columns = x.map((_, k) => {
      const shifted = [...x]
      shifted[k] = (shifted[k] ?? 0) + step
      const { r } = residuals(shifted)
      return r.map((value, i) => (value - (current.r[i] ?? 0)) / step)
    })
    const n = x.length
    const jtj = Array.from({ length: n }, (_, a) =>
      Array.from({ length: n }, (__, b) => columns[a]!.reduce((sum, value, i) => sum + value * columns[b]![i]!, 0)),
    )
    const jtr = columns.map((column) => column.reduce((sum, value, i) => sum + value * (current.r[i] ?? 0), 0))
    let improved = false
    for (let attempt = 0; attempt < 6 && !improved; attempt++) {
      const damped = jtj.map((row, a) => row.map((value, b) => (a === b ? value * (1 + mu) + 1e-9 : value)))
      const delta = solve(
        damped,
        jtr.map((value) => -value),
      )
      const candidate = toVector(toPhenotype(x.map((value, k) => value + (delta[k] ?? 0))))
      const next = residuals(candidate)
      if (cost(next.r) < cost(current.r)) {
        x = candidate
        current = next
        mu = Math.max(mu / 3, 1e-6)
        improved = true
      } else mu *= 4
    }
    options.onIteration?.(toPhenotype(x), iteration, iterations)
    if (!improved) break
  }
  const featureCount = bodyFeatureNames.filter((name) => calibration.features[name]).length
  const featureResiduals = current.r.slice(0, featureCount)
  return {
    phenotype: toPhenotype(x),
    residual: Math.sqrt(cost(featureResiduals) / Math.max(featureCount, 1)),
    stature: current.stature,
    evaluations,
  }
}
