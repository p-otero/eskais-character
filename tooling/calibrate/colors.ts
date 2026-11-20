// Colour and hair-shape accuracy on cached synthetic detections: bun tooling/calibrate/colors.ts [--seed=1]
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { deltaE, sampleFaceColors, type Rgb } from "../../src/scan/colors.ts"
import { hairStyle } from "../../src/model/hair.ts"
import { pickHairLength } from "../../src/scan/hair-pick.ts"
import { decodePng } from "../synth/png.ts"
import type { Subject } from "../synth/subjects.ts"

const seeds = (process.argv.find((a) => a.startsWith("--seed="))?.slice(7) ?? "1,2000").split(",")
const rows: { subject: Subject; colors: ReturnType<typeof sampleFaceColors> }[] = []
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
      subject: data.subject,
      colors: sampleFaceColors({ width: png.width, height: png.height, data: png.rgba }, data.face.landmarks),
    })
  }
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1)
const median = (xs: number[]) => [...xs].toSorted((a, b) => a - b)[xs.length >> 1] ?? 0
for (const key of ["skin", "eyes", "brows", "hair"] as const) {
  const errors = rows.flatMap(({ subject, colors }) => {
    const truth = subject.colors[key] as Rgb
    const got = colors[key]
    if (key === "hair" && subject.hair === "none") return []
    return got ? [deltaE(truth, got)] : [99]
  })
  console.log(
    `${key.padEnd(6)} ΔE mean ${mean(errors).toFixed(1)} median ${median(errors).toFixed(1)} (n ${String(errors.length)})`,
  )
}
const beardTruth = rows.map(({ subject }) => subject.colors.beard !== null)
const beardGot = rows.map(({ colors }) => colors.beard !== null)
const beardAccuracy = mean(beardTruth.map((truth, i) => (truth === beardGot[i] ? 1 : 0)))
console.log(
  `beard score with ${rows
    .filter((r) => r.subject.colors.beard)
    .map((r) => r.colors.beardScore.toFixed(1))
    .join(" ")} | without ${rows
    .filter((r) => !r.subject.colors.beard)
    .map((r) => r.colors.beardScore.toFixed(1))
    .join(" ")}`,
)
console.log(
  `beard presence accuracy ${(beardAccuracy * 100).toFixed(0)}% (${String(beardTruth.filter(Boolean).length)} with beard)`,
)
const byStyle = new Map<string, number[][]>()
for (const { subject, colors } of rows) {
  const list = byStyle.get(subject.hair) ?? []
  list.push([colors.hairShape.coverage, colors.hairShape.crown, colors.hairShape.fall])
  byStyle.set(subject.hair, list)
}
for (const [style, list] of byStyle)
  console.log(
    `${style.padEnd(7)} coverage ${list.map((x) => x[0]!.toFixed(2)).join(" ")} | crown ${list.map((x) => x[1]!.toFixed(2)).join(" ")} | fall ${list.map((x) => x[2]!.toFixed(2)).join(" ")}`,
  )
const correct = rows.filter(({ subject, colors }) => pickHairLength(colors) === hairStyle(subject.hair).length).length
console.log(`hair style accuracy ${String(correct)}/${String(rows.length)}`)
