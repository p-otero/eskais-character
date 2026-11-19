// Full measurement for the spike report: accuracy end to end through the real engine on a held-out synthetic set,
// time per stage on CPU, GPU and phone emulation, model load, memory and download sizes.
// Usage: bun tooling/perf/run.ts [--seed=1] [--profiles=desktopCpu,desktopGpu,phone] [--phone-subjects=6]
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  bodyCoefficients,
  evaluateShape,
  neutralPhenotype,
  phenotypeLabels,
  type Phenotype,
} from "../../src/model/anny.ts"
import { deltaE } from "../../src/scan/colors.ts"
import { statureOf } from "../../src/scan/fit-body.ts"
import { loadAnny } from "../../test/load-anny.ts"
import { buildHarness } from "../browser/build-harness.mjs"
import type { Rgb, Subject } from "../synth/subjects.ts"
import { downloadSizes, median, runBench, stageSummary } from "./bench.mjs"

const arg = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const seed = arg("seed", "1")
const dir = `.cache/detections/seed-${seed}`
const model = loadAnny()
const subjects = readdirSync(dir)
  .filter((file) => file.endsWith(".json"))
  .map((file) => {
    const data = JSON.parse(readFileSync(join(dir, file), "utf8")) as { subject: Subject }
    const stature = statureOf(evaluateShape(model, { body: bodyCoefficients(model, data.subject.phenotype) }).vertices)
    return {
      id: data.subject.id,
      face: Array.from(readFileSync(join(dir, file.replace(".json", "-face.png")))),
      body: Array.from(readFileSync(join(dir, file.replace(".json", "-body.png")))),
      truth: { ...data.subject, statureCm: Math.round(stature * 1000) / 10 },
    }
  })
await buildHarness()

const hex = (value: string): Rgb => [1, 3, 5].map((i) => Number.parseInt(value.slice(i, i + 2), 16)) as Rgb
const headRms = (a: Float32Array, b: Float32Array) => {
  let sum = 0
  for (const v of model.headSubset) for (let k = 0; k < 3; k++) sum += (a[v * 3 + k]! - b[v * 3 + k]!) ** 2
  return Math.sqrt(sum / model.headSubset.length) * 1000
}

/** Whole-body vertex RMS in mm, between two rest shapes of the same mesh. */
function bodyRms(a: Float32Array, b: Float32Array) {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += (a[i]! - b[i]!) ** 2
  return Math.sqrt(sum / (a.length / 3)) * 1000
}

interface Scan {
  id: string
  params: { phenotype: Phenotype; face: Record<string, number> }
  colors: Record<string, string | null>
  hair: string
}
function accuracy(scans: Scan[]) {
  const phenotype: Record<string, { fit: number; neutral: number }> = {}
  let headFit = 0
  let headNeutral = 0
  let bodyFitMm = 0
  let bodyNeutralMm = 0
  const color: Record<string, number[]> = { skin: [], eyes: [], hair: [], brows: [] }
  let beardRight = 0
  let hairRight = 0
  for (const scan of scans) {
    const truth = subjects.find((subject) => subject.id === scan.id)!.truth
    for (const label of phenotypeLabels) {
      const entry = (phenotype[label] ??= { fit: 0, neutral: 0 })
      entry.fit += Math.abs(scan.params.phenotype[label] - truth.phenotype[label]) / scans.length
      entry.neutral += Math.abs(neutralPhenotype[label] - truth.phenotype[label]) / scans.length
    }
    const truthFace = model.faceModifierLabels.map((label) => truth.face[label] ?? 0)
    const fitFace = model.faceModifierLabels.map((label) => scan.params.face[label] ?? 0)
    const truthBody = bodyCoefficients(model, truth.phenotype)
    const truthShape = evaluateShape(model, { body: truthBody, face: truthFace }).vertices
    headFit += headRms(truthShape, evaluateShape(model, { body: truthBody, face: fitFace }).vertices) / scans.length
    headNeutral += headRms(truthShape, evaluateShape(model, { body: truthBody }).vertices) / scans.length
    const truthBodyShape = evaluateShape(model, { body: truthBody }).vertices
    bodyFitMm +=
      bodyRms(truthBodyShape, evaluateShape(model, { body: bodyCoefficients(model, scan.params.phenotype) }).vertices) /
      scans.length
    bodyNeutralMm +=
      bodyRms(truthBodyShape, evaluateShape(model, { body: bodyCoefficients(model, neutralPhenotype) }).vertices) /
      scans.length
    for (const key of ["skin", "eyes", "brows"] as const)
      color[key]!.push(deltaE(truth.colors[key], hex(scan.colors[key]!)))
    if (truth.hair !== "none") color["hair"]!.push(deltaE(truth.colors.hair, hex(scan.colors["hair"]!)))
    if ((truth.colors.beard !== null) === (scan.colors["beard"] !== null)) beardRight++
    if (truth.hair === scan.hair) hairRight++
  }
  return {
    phenotype,
    faceHeadRmsMm: { fit: headFit, neutral: headNeutral },
    bodyVertexRmsMm: { fit: bodyFitMm, neutral: bodyNeutralMm },
    colorDeltaE: Object.fromEntries(
      Object.entries(color).map(([key, values]) => [
        key,
        { median: median(values), mean: values.reduce((a, b) => a + b, 0) / values.length },
      ]),
    ),
    beardPresence: beardRight / scans.length,
    hairStyle: hairRight / scans.length,
  }
}

const results: Record<string, unknown> = {
  seed,
  subjects: subjects.length,
  date: new Date().toISOString(),
  downloads: downloadSizes(),
}
for (const profile of arg("profiles", "desktopCpu,desktopGpu,phone").split(",")) {
  const count = profile === "phone" ? Number(arg("phone-subjects", "6")) : subjects.length
  for (const heightCm of profile === "desktopCpu" ? [false, true] : [false]) {
    const run = await runBench(profile, subjects.slice(0, count), { heightCm })
    const key = heightCm ? `${profile}+height` : profile
    results[key] = { ...run, stages: stageSummary(run), accuracy: accuracy(run.scans as Scan[]), scans: undefined }
    const stages = stageSummary(run)
    console.log(
      `\n${String(run.label)}${heightCm ? " (stature hint)" : ""}: delegate ${String(run.delegate)}, models ready ${String(run.initMs.toFixed(0))} ms, ${String(count)} scans`,
    )
    console.log(
      `  median ms: ${Object.entries(stages)
        .map(([stage, ms]) => `${stage} ${(ms as number).toFixed(0)}`)
        .join(", ")}`,
    )
    console.log(
      `  long tasks > 50 ms: ${String((run.longTasks as number[]).filter((ms) => ms > 50).length)}, memory ${run.memoryBytes ? `${(run.memoryBytes / 2 ** 20).toFixed(0)} MiB` : "n/a"}`,
    )
    console.log(`  accuracy: ${JSON.stringify(accuracy(run.scans as Scan[]))}`)
  }
}
mkdirSync("tooling/perf/results", { recursive: true })
writeFileSync(`tooling/perf/results/report-seed-${seed}.json`, JSON.stringify(results, null, 2) + "\n")
console.log("\nDownloads:")
for (const file of results["downloads"] as { name: string; raw: number; gzip: number; brotli: number }[])
  console.log(
    `  ${file.name.padEnd(40)} raw ${(file.raw / 1e6).toFixed(2)} MB  gzip ${(file.gzip / 1e6).toFixed(2)} MB  brotli ${(file.brotli / 1e6).toFixed(2)} MB`,
  )
