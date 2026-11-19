// Trains the learned priors (src/scan/priors.ts) on a synthetic training set's cached detections, choosing the ridge
// strength by 5-fold cross-validation. Usage: bun tooling/calibrate/train-priors.ts [--seed=4000]
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { phenotypeLabels } from "../../src/model/anny.ts"
import type { FaceLandmarkMap } from "../../src/scan/fit-face.ts"
import { bodyFeatureNames, type BodyFeatures } from "../../src/scan/measure-body.ts"
import { alignedFaceShape, predictLinear, type FacePrior, type LinearPrior } from "../../src/scan/priors.ts"
import { loadAnny } from "../../test/load-anny.ts"
import type { Subject } from "../synth/subjects.ts"

const seed = process.argv.find((a) => a.startsWith("--seed="))?.slice(7) ?? "4000"
const dir = `.cache/detections/seed-${seed}`
const model = loadAnny()
interface Sample {
  subject: Subject
  face: { landmarks: number[] | null }
  body?: { features: BodyFeatures | null }
  faceSize: [number, number]
}
const samples = readdirSync(dir)
  .filter((file) => file.endsWith(".json"))
  .map((file) => JSON.parse(readFileSync(join(dir, file), "utf8")) as Sample)

/** Cholesky solve of (K + αI) X = B for symmetric positive definite K; B is m × q row-major. */
function solveSpd(k: Float64Array, m: number, alpha: number, b: Float64Array, q: number): Float64Array {
  const l = new Float64Array(m * m)
  for (let i = 0; i < m; i++)
    for (let j = 0; j <= i; j++) {
      let sum = k[i * m + j]! + (i === j ? alpha : 0)
      for (let p = 0; p < j; p++) sum -= l[i * m + p]! * l[j * m + p]!
      l[i * m + j] = i === j ? Math.sqrt(Math.max(sum, 1e-12)) : sum / l[j * m + j]!
    }
  const x = new Float64Array(m * q)
  for (let c = 0; c < q; c++) {
    const y = new Float64Array(m)
    for (let i = 0; i < m; i++) {
      let sum = b[i * q + c]!
      for (let p = 0; p < i; p++) sum -= l[i * m + p]! * y[p]!
      y[i] = sum / l[i * m + i]!
    }
    for (let i = m - 1; i >= 0; i--) {
      let sum = y[i]!
      for (let p = i + 1; p < m; p++) sum -= l[p * m + i]! * x[p * q + c]!
      x[i * q + c] = sum / l[i * m + i]!
    }
  }
  return x
}

/** Ridge regression in the dual (works for more inputs than samples). Returns a LinearPrior. */
function ridge(inputs: number[][], outputs: number[][], alpha: number): LinearPrior {
  const m = inputs.length
  const p = inputs[0]!.length
  const q = outputs[0]!.length
  const inputMean = Array.from({ length: p }, (_, j) => inputs.reduce((s, row) => s + row[j]!, 0) / m)
  const inputScale = Array.from(
    { length: p },
    (_, j) => Math.sqrt(inputs.reduce((s, row) => s + (row[j]! - inputMean[j]!) ** 2, 0) / m) || 1,
  )
  const intercept = Array.from({ length: q }, (_, c) => outputs.reduce((s, row) => s + row[c]!, 0) / m)
  const xs = inputs.map((row) => row.map((value, j) => (value - inputMean[j]!) / inputScale[j]!))
  const k = new Float64Array(m * m)
  for (let i = 0; i < m; i++)
    for (let j = 0; j <= i; j++) {
      let sum = 0
      for (let f = 0; f < p; f++) sum += xs[i]![f]! * xs[j]![f]!
      k[i * m + j] = sum
      k[j * m + i] = sum
    }
  const yc = new Float64Array(m * q)
  outputs.forEach((row, i) => row.forEach((value, c) => (yc[i * q + c] = value - intercept[c]!)))
  const a = solveSpd(k, m, alpha * m, yc, q)
  const weights = Array.from({ length: q * p }, () => 0)
  for (let c = 0; c < q; c++)
    for (let i = 0; i < m; i++) {
      const coefficient = a[i * q + c]!
      for (let f = 0; f < p; f++) weights[c * p + f]! += coefficient * xs[i]![f]!
    }
  return { inputMean, inputScale, intercept, weights, residualSigma: Array.from({ length: q }, () => 0) }
}

/**
 * 5-fold cross-validation over the ridge strengths, chosen per output: an output the inputs don't predict gets the
 * strongest shrinkage (its prediction falls back to the training mean). Returns the per-output alpha, held-out R²
 * and residual sigma, and a prior assembled from each output's best model.
 */
function crossValidate(inputs: number[][], outputs: number[][], alphas: number[]) {
  const q = outputs[0]!.length
  const best = Array.from({ length: q }, () => ({ alpha: alphas[0]!, sse: Number.POSITIVE_INFINITY }))
  for (const alpha of alphas) {
    const sse = Array.from({ length: q }, () => 0)
    for (let fold = 0; fold < 5; fold++) {
      const trainIdx = inputs.map((_, i) => i).filter((i) => i % 5 !== fold)
      const testIdx = inputs.map((_, i) => i).filter((i) => i % 5 === fold)
      const prior = ridge(
        trainIdx.map((i) => inputs[i]!),
        trainIdx.map((i) => outputs[i]!),
        alpha,
      )
      for (const i of testIdx) {
        const predicted = predictLinear(prior, inputs[i]!)
        outputs[i]!.forEach((truth, c) => (sse[c] = sse[c]! + (predicted[c]! - truth) ** 2))
      }
    }
    sse.forEach((value, c) => {
      if (value < best[c]!.sse) best[c] = { alpha, sse: value }
    })
  }
  const r2 = best.map(({ sse }, c) => {
    const values = outputs.map((row) => row[c]!)
    const m = values.reduce((sum, v) => sum + v, 0) / values.length
    return Math.max(0, 1 - sse / values.reduce((sum, v) => sum + (v - m) ** 2, 0))
  })
  const sigma = best.map(({ sse }) => Math.sqrt(sse / inputs.length))
  // One model per distinct alpha, then each output takes its row from the model with its alpha.
  const models = new Map(best.map(({ alpha }) => [alpha, ridge(inputs, outputs, alpha)]))
  const first = models.get(best[0]!.alpha)!
  const p = first.inputMean.length
  const weights = Array.from({ length: q * p }, () => 0)
  best.forEach(({ alpha }, c) => {
    const chosen = models.get(alpha)!
    // An output nothing predicts keeps its mean: its row stays zero.
    if (r2[c]! < 0.05) return
    for (let f = 0; f < p; f++) weights[c * p + f] = chosen.weights[c * p + f]!
  })
  const prior: LinearPrior = { ...first, weights, residualSigma: sigma }
  const mae = best.reduce((sum, { sse }) => sum + Math.sqrt(sse / inputs.length), 0) / q
  return { prior, r2, sigma, alphas: best.map(({ alpha }) => alpha), mae }
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
const alphas = (process.argv.find((a) => a.startsWith("--alphas="))?.slice(9) ?? "0.001,0.003,0.01,0.03,0.1,0.3,1,3")
  .split(",")
  .map(Number)

// Face.
const map = JSON.parse(readFileSync("assets/anny/face-landmarks.json", "utf8")) as FaceLandmarkMap
const indices = map.landmarks.flatMap((entry, index) =>
  entry.spreadMm !== null && entry.spreadMm <= 6 && index < 468 ? [index] : [],
)
const faces = samples.filter((sample) => sample.face.landmarks)
let meanShape = Array.from(
  alignedFaceShape(
    faces[0]!.face.landmarks!,
    faces[0]!.faceSize[0],
    faces[0]!.faceSize[1],
    indices,
    Array.from({ length: indices.length * 2 }, () => 0),
  ),
)
for (let round = 0; round < 4; round++) {
  const sum = new Float64Array(indices.length * 2)
  for (const sample of faces) {
    const residual = alignedFaceShape(
      sample.face.landmarks!,
      sample.faceSize[0],
      sample.faceSize[1],
      indices,
      meanShape,
    )
    residual.forEach((value, k) => (sum[k] = sum[k]! + value + meanShape[k]!))
  }
  const next = Array.from(sum, (value) => value / faces.length)
  const size = Math.sqrt(next.reduce((s, v) => s + v * v, 0) / indices.length)
  meanShape = next.map((value) => value / size)
}
const faceInputs = faces.map((sample) =>
  Array.from(alignedFaceShape(sample.face.landmarks!, sample.faceSize[0], sample.faceSize[1], indices, meanShape)),
)
const faceOutputs = faces.map((sample) => model.faceModifierLabels.map((label) => sample.subject.face[label] ?? 0))
const faceCv = crossValidate(faceInputs, faceOutputs, alphas)
const baselineFace = mean(faceOutputs.flat().map(Math.abs))
console.log(
  `face R² by modifier: ${model.faceModifierLabels.map((label, k) => `${label} ${faceCv.r2[k]!.toFixed(2)}`).join(", ")}`,
)
console.log(
  `face prior: ${String(faces.length)} samples, ${String(indices.length)} landmarks, CV RMS ${faceCv.mae.toFixed(3)} (|truth| mean ${baselineFace.toFixed(3)})`,
)
const facePrior: FacePrior = { ...faceCv.prior, landmarks: indices, meanShape }
const round = (values: number[], digits = 6) => values.map((value) => Number(value.toPrecision(digits)))
writeFileSync(
  "assets/anny/face-prior.json",
  JSON.stringify({
    format: "eskais-face-prior/1",
    note: `Ridge regression, aligned MediaPipe face landmarks → Anny face modifiers; trained on synthetic people (seed ${seed}).`,
    outputs: model.faceModifierLabels,
    ...facePrior,
    inputMean: round(facePrior.inputMean),
    inputScale: round(facePrior.inputScale),
    intercept: round(facePrior.intercept),
    weights: round(facePrior.weights, 5),
    meanShape: round(facePrior.meanShape),
    residualSigma: round(facePrior.residualSigma, 4),
    r2: round(faceCv.r2, 3),
  }) + "\n",
)

// Body.
const bodies = samples.filter((sample) => sample.body?.features)
const bodyInputs = bodies.map((sample) => bodyFeatureNames.map((name) => sample.body!.features![name]))
const bodyOutputs = bodies.map((sample) => phenotypeLabels.map((label) => sample.subject.phenotype[label]))
const bodyCv = crossValidate(bodyInputs, bodyOutputs, alphas)
console.log(`body R²: ${phenotypeLabels.map((label, k) => `${label} ${bodyCv.r2[k]!.toFixed(2)}`).join(", ")}`)
console.log(
  `body prior: ${String(bodies.length)} samples; held-out sigma ${phenotypeLabels.map((label, k) => `${label} ${bodyCv.sigma[k]!.toFixed(3)}`).join(", ")}`,
)
const bodyPrior: LinearPrior = bodyCv.prior
writeFileSync(
  "assets/anny/body-prior.json",
  JSON.stringify(
    {
      format: "eskais-body-prior/1",
      note: `Ridge regression, body features → Anny phenotypes; trained on synthetic people (seed ${seed}).`,
      inputs: bodyFeatureNames,
      outputs: phenotypeLabels,
      ...bodyPrior,
      r2: bodyCv.r2,
    },
    null,
    2,
  ) + "\n",
)
