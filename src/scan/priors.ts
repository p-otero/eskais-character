// Learned priors: ridge regressions trained on synthetic people (tooling/calibrate/train-priors.ts). They give the
// geometric fits a starting point and a centre to regularise towards, which absorbs MediaPipe's systematic shrinkage
// of subtle shape differences. Both are a single matrix product at runtime.

export interface LinearPrior {
  /** Input mean and scale (standardisation), output = intercept + weights · standardised input. */
  inputMean: number[]
  inputScale: number[]
  intercept: number[]
  /** outputs × inputs, row-major. */
  weights: number[]
  /** Residual standard deviation of each output on held-out data. */
  residualSigma: number[]
  /** Held-out R² of each output: how much of it the inputs predict. */
  r2?: number[]
}

export function predictLinear(prior: LinearPrior, input: ArrayLike<number>): Float64Array {
  const inputs = prior.inputMean.length
  const outputs = prior.intercept.length
  const out = new Float64Array(outputs)
  for (let o = 0; o < outputs; o++) {
    let sum = prior.intercept[o] ?? 0
    for (let i = 0; i < inputs; i++)
      sum +=
        (prior.weights[o * inputs + i] ?? 0) *
        (((input[i] ?? 0) - (prior.inputMean[i] ?? 0)) / (prior.inputScale[i] ?? 1))
    out[o] = sum
  }
  return out
}

export interface FacePrior extends LinearPrior {
  /** Landmark indices used, and their mean 2D shape (x, y pairs, unit RMS size, centred). */
  landmarks: number[]
  meanShape: number[]
}

/**
 * The face's 2D landmarks aligned onto the mean shape by a similarity (Procrustes), as the regression's input: the
 * residual (x, y) of each landmark from the mean. Image y points down; it is flipped so the shape is upright.
 */
export function alignedFaceShape(
  landmarks: ArrayLike<number>,
  width: number,
  height: number,
  indices: readonly number[],
  meanShape: readonly number[],
): Float64Array {
  const n = indices.length
  const points = new Float64Array(n * 2)
  let cx = 0
  let cy = 0
  indices.forEach((landmark, k) => {
    points[k * 2] = (landmarks[landmark * 3] ?? 0) * width
    points[k * 2 + 1] = -(landmarks[landmark * 3 + 1] ?? 0) * height
    cx += points[k * 2] ?? 0
    cy += points[k * 2 + 1] ?? 0
  })
  cx /= n
  cy /= n
  let size = 0
  for (let k = 0; k < n; k++) {
    points[k * 2] = (points[k * 2] ?? 0) - cx
    points[k * 2 + 1] = (points[k * 2 + 1] ?? 0) - cy
    size += (points[k * 2] ?? 0) ** 2 + (points[k * 2 + 1] ?? 0) ** 2
  }
  size = Math.sqrt(size / n) || 1
  // Optimal rotation onto the mean shape (2D Procrustes): angle from the summed cross and dot products.
  let dot = 0
  let cross = 0
  for (let k = 0; k < n; k++) {
    const x = (points[k * 2] ?? 0) / size
    const y = (points[k * 2 + 1] ?? 0) / size
    const mx = meanShape[k * 2] ?? 0
    const my = meanShape[k * 2 + 1] ?? 0
    dot += x * mx + y * my
    cross += x * my - y * mx
  }
  const angle = Math.atan2(cross, dot)
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const out = new Float64Array(n * 2)
  for (let k = 0; k < n; k++) {
    const x = (points[k * 2] ?? 0) / size
    const y = (points[k * 2 + 1] ?? 0) / size
    out[k * 2] = cos * x - sin * y - (meanShape[k * 2] ?? 0)
    out[k * 2 + 1] = sin * x + cos * y - (meanShape[k * 2 + 1] ?? 0)
  }
  return out
}
