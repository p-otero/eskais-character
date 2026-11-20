// Fits the hair-length thresholds (src/scan/hair-pick.ts) on a training seed by grid search, then reports accuracy on
// held-out seeds. Usage: bun tooling/calibrate/hair-thresholds.ts [--train=4000] [--test=1,2000]
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { hairStyle } from "../../src/model/hair.ts"
import { sampleFaceColors, type FaceColors } from "../../src/scan/colors.ts"
import { pickHairLength, type hairThresholds } from "../../src/scan/hair-pick.ts"
import { decodePng } from "../synth/png.ts"
import type { Subject } from "../synth/subjects.ts"

const arg = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback

function load(seeds: string[]) {
  const rows: { truth: string; colors: FaceColors }[] = []
  for (const seed of seeds) {
    const dir = `.cache/detections/seed-${seed}`
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      const data = JSON.parse(readFileSync(join(dir, file), "utf8")) as {
        subject: Subject
        face: { landmarks: number[] | null }
      }
      if (!data.face.landmarks) continue
      const png = decodePng(readFileSync(join(dir, file.replace(".json", "-face.png"))))
      rows.push({
        truth: hairStyle(data.subject.hair).length,
        colors: sampleFaceColors({ width: png.width, height: png.height, data: png.rgba }, data.face.landmarks),
      })
    }
  }
  return rows
}

type Thresholds = typeof hairThresholds
const accuracy = (rows: ReturnType<typeof load>, t: Thresholds) =>
  rows.filter((row) => pickHairLength(row.colors, t) === row.truth).length / rows.length
const train = load(arg("train", "4000").split(","))
const test = load(arg("test", "1,2000").split(","))
for (const length of ["none", "buzz", "short", "medium", "long"]) {
  const falls = train.filter((row) => row.truth === length).map((row) => row.colors.hairShape.fall.toFixed(2))
  console.log(`${length.padEnd(7)} n=${String(falls.length)} fall ${falls.slice(0, 18).join(" ")}`)
}
let best: { t: Thresholds; score: number } = { t: { coverage: 0.3, long: 1.3, medium: 0.6, short: 0.05 }, score: 0 }
for (const coverage of [0.15, 0.2, 0.3, 0.4])
  for (const short of [0.02, 0.05, 0.1, 0.15, 0.2])
    for (const medium of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1])
      for (const long of [1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6]) {
        if (!(short < medium && medium < long)) continue
        const t = { coverage, short, medium, long }
        const score = accuracy(train, t)
        if (score > best.score) best = { t, score }
      }
console.log(
  `best on training seed: ${JSON.stringify(best.t)} ${(best.score * 100).toFixed(0)}%; held-out ${(accuracy(test, best.t) * 100).toFixed(0)}% (n ${String(test.length)})`,
)
