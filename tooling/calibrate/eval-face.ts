// Face-fit recovery on cached detections of a held-out synthetic set, for three variants: the geometric fit alone,
// the learned prior alone, and the prior refined by the geometric fit on the observable modifiers (what the scan does).
// Usage: bun tooling/calibrate/eval-face.ts [--seed=1] [--json]
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { bodyCoefficients, evaluateShape } from "../../src/model/anny.ts"
import { fitFace, type FaceLandmarkMap } from "../../src/scan/fit-face.ts"
import { alignedFaceShape, predictLinear, type FacePrior } from "../../src/scan/priors.ts"
import { loadAnny } from "../../test/load-anny.ts"
import type { Subject } from "../synth/subjects.ts"

const arg = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const dir = `.cache/detections/seed-${arg("seed", "1")}`
const model = loadAnny()
const map = JSON.parse(readFileSync("assets/anny/face-landmarks.json", "utf8")) as FaceLandmarkMap
const prior = JSON.parse(readFileSync("assets/anny/face-prior.json", "utf8")) as FacePrior
const free = model.faceModifierLabels.map((_, k) => (prior.r2?.[k] ?? 0) >= 0.15)

interface Data {
  subject: Subject
  face: { landmarks: number[] | null; blendshapes: Record<string, number> }
  faceSize: [number, number]
}
const variants = ["geometric", "prior", "prior+geometric"] as const
const totals = Object.fromEntries(variants.map((v) => [v, { all: 0, observable: 0, headMm: 0 }])) as Record<
  (typeof variants)[number],
  { all: number; observable: number; headMm: number }
>
const baseline = { all: 0, observable: 0, headMm: 0 }
let subjects = 0
const headRms = (a: Float32Array, b: Float32Array) => {
  let sum = 0
  for (const v of model.headSubset) for (let k = 0; k < 3; k++) sum += (a[v * 3 + k]! - b[v * 3 + k]!) ** 2
  return Math.sqrt(sum / model.headSubset.length) * 1000
}
for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
  const data = JSON.parse(readFileSync(join(dir, file), "utf8")) as Data
  if (!data.face.landmarks) continue
  subjects++
  const body = bodyCoefficients(model, data.subject.phenotype)
  const observation = {
    landmarks: data.face.landmarks,
    blendshapes: data.face.blendshapes,
    width: data.faceSize[0],
    height: data.faceSize[1],
  }
  const truth = model.faceModifierLabels.map((label) => data.subject.face[label] ?? 0)
  const truthShape = evaluateShape(model, { body, face: truth }).vertices
  const predicted = predictLinear(
    prior,
    alignedFaceShape(data.face.landmarks, data.faceSize[0], data.faceSize[1], prior.landmarks, prior.meanShape),
  )
  const results = {
    geometric: fitFace(model, map, body, observation, { lambda: 5e-6 }).face,
    prior: Float32Array.from(predicted, (value) => Math.min(Math.max(value, -1), 1)),
    "prior+geometric": fitFace(model, map, body, observation, {
      prior: predicted,
      free,
      lambda: Number(arg("lambda", "2e-6")),
    }).face,
  }
  const score = (values: ArrayLike<number>, into: { all: number; observable: number; headMm: number }) => {
    let all = 0
    let observable = 0
    truth.forEach((t, k) => {
      const error = Math.abs((values[k] ?? 0) - t)
      all += error / truth.length
      if (free[k]) observable += error / free.filter(Boolean).length
    })
    into.all += all
    into.observable += observable
    into.headMm += headRms(truthShape, evaluateShape(model, { body, face: values }).vertices)
  }
  for (const variant of variants) score(results[variant], totals[variant])
  score(new Float32Array(truth.length), baseline)
}
const line = (name: string, t: { all: number; observable: number; headMm: number }) =>
  `${name.padEnd(16)} MAE all ${(t.all / subjects).toFixed(3)}  observable ${(t.observable / subjects).toFixed(3)}  head RMS ${(t.headMm / subjects).toFixed(2)} mm`
console.log(
  `${String(subjects)} held-out subjects; ${String(free.filter(Boolean).length)} observable modifiers: ${model.faceModifierLabels.filter((_, k) => free[k]).join(", ")}`,
)
console.log(line("neutral face", baseline))
for (const variant of variants) console.log(line(variant, totals[variant]))
