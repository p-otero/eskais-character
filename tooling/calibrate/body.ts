// Calibrates model body features against MediaPipe measurements on synthetic people (seed 2000), then evaluates the
// body fit on another set (seed 1). Usage: bun tooling/calibrate/body.ts [--write] [--prior=0.35]
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { neutralPhenotype, phenotypeLabels, type Phenotype } from "../../src/model/anny.ts"
import { createBodyFeatureModel, fitBody, type BodyCalibration } from "../../src/scan/fit-body.ts"
import { bodyFeatureNames, type BodyFeatures } from "../../src/scan/measure-body.ts"
import { predictLinear, type LinearPrior } from "../../src/scan/priors.ts"
import { loadAnny } from "../../test/load-anny.ts"
import type { Subject } from "../synth/subjects.ts"

const arg = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const model = loadAnny()
const featureModel = createBodyFeatureModel(model)

function load(seed: number) {
  const dir = `.cache/detections/seed-${String(seed)}`
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map(
      (file) =>
        JSON.parse(readFileSync(join(dir, file), "utf8")) as {
          subject: Subject
          body: { features: BodyFeatures | null }
        },
    )
    .filter((data) => data.body.features)
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
const train = load(2000)
const calibration: BodyCalibration = { features: {} }
for (const name of bodyFeatureNames) {
  const pairs = train.map(
    (data) => [featureModel(data.subject.phenotype).features[name], data.body.features![name]] as const,
  )
  const n = pairs.length
  const mx = pairs.reduce((s, [x]) => s + x, 0) / n
  const my = pairs.reduce((s, [, y]) => s + y, 0) / n
  const sxx = pairs.reduce((s, [x]) => s + (x - mx) ** 2, 0)
  const sxy = pairs.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0)
  const slope = sxy / sxx
  const offset = my - slope * mx
  const sigma = Math.sqrt(pairs.reduce((s, [x, y]) => s + (y - offset - slope * x) ** 2, 0) / (n - 2))
  const r = sxy / Math.sqrt(sxx * pairs.reduce((s, [, y]) => s + (y - my) ** 2, 0))
  calibration.features[name] = { offset, slope, sigma: Math.max(sigma, 1e-4) }
  console.log(
    `${name.padEnd(14)} slope ${slope.toFixed(3)} offset ${offset.toFixed(4)} sigma ${sigma.toFixed(4)} r ${r.toFixed(3)}`,
  )
}
if (process.argv.includes("--write"))
  writeFileSync(
    "assets/anny/body-calibration.json",
    JSON.stringify(
      {
        format: "eskais-body-calibration/1",
        note: "measured ≈ offset + slope × model feature, on synthetic people (tooling/calibrate/body.ts, seed 2000)",
        ...calibration,
      },
      null,
      2,
    ) + "\n",
  )

const test = load(Number(arg("seed", "1")))
const prior = Number(arg("prior", "0.35"))
const learned = JSON.parse(readFileSync("assets/anny/body-prior.json", "utf8")) as LinearPrior
for (const [variant, withStature] of [
  ["fit", false],
  ["prior", false],
  ["prior+fit", false],
  ["prior+fit", true],
] as const) {
  const errors: Record<string, number[]> = {}
  const baseline: Record<string, number[]> = {}
  let statureError = 0
  let ms = 0
  for (const data of test) {
    const truth = featureModel(data.subject.phenotype)
    const started = performance.now()
    const predicted = predictLinear(
      learned,
      bodyFeatureNames.map((name) => data.body.features![name]),
    )
    const fit =
      variant === "prior"
        ? {
            phenotype: Object.fromEntries(
              phenotypeLabels.map((label, k) => [
                label,
                Math.min(Math.max(predicted[k]!, label === "age" ? 0.6 : 0), 1),
              ]),
            ) as Phenotype,
            stature: featureModel(
              Object.fromEntries(phenotypeLabels.map((label, k) => [label, predicted[k]!])) as Phenotype,
            ).stature,
          }
        : fitBody(
            model,
            calibration,
            data.body.features!,
            {
              priorSigma: prior,
              ...(variant === "prior+fit" ? { prior: { mean: predicted, sigma: learned.residualSigma } } : {}),
              ...(withStature ? { stature: truth.stature } : {}),
            },
            featureModel,
          )
    ms += performance.now() - started
    statureError += Math.abs(fit.stature - truth.stature)
    for (const label of phenotypeLabels) {
      ;(errors[label] ??= []).push(Math.abs(fit.phenotype[label] - data.subject.phenotype[label]))
      ;(baseline[label] ??= []).push(Math.abs(neutralPhenotype[label] - data.subject.phenotype[label]))
    }
  }
  console.log(
    `\n${withStature ? "with" : "without"} stature hint (${String(test.length)} subjects, ${(ms / test.length).toFixed(0)} ms/fit, stature MAE ${((statureError / test.length) * 100).toFixed(1)} cm)`,
  )
  for (const label of phenotypeLabels)
    console.log(
      `  ${label.padEnd(12)} MAE ${mean(errors[label]!).toFixed(3)}  (neutral baseline ${mean(baseline[label]!).toFixed(3)})`,
    )
}
