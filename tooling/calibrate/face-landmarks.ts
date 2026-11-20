// Calibrates where MediaPipe's 478 face landmarks sit on Anny's mesh: renders synthetic bald faces with known shapes,
// detects them, and maps each landmark's pixel back onto the mesh triangle it lands on. The map is the average over
// subjects; its per-landmark spread becomes the landmark's weight in the face fit.
// Usage: bun tooling/calibrate/face-landmarks.ts [--count=24]
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { loadAnny } from "../../test/load-anny.ts"
import { startDetector } from "../browser/detector.ts"
import { encodePng } from "../synth/png.ts"
import { renderPick } from "../synth/raster.ts"
import { prepareSubject, renderSubject, supersample } from "../synth/render.ts"
import { makeSubjects } from "../synth/subjects.ts"

const count = Number(process.argv.find((arg) => arg.startsWith("--count="))?.slice(8) ?? "24")
const model = loadAnny()
const subjects = makeSubjects(model, count, 1000).map((subject) => ({
  ...subject,
  hair: "none",
  colors: { ...subject.colors, beard: null },
}))
const detector = await startDetector()
const LANDMARKS = 478
const maps = Array.from({ length: LANDMARKS }, () => new Map<number, number>())
const hits = new Int32Array(LANDMARKS)
const picked: { subject: number; landmark: number; point: [number, number, number] }[] = []
const blendTotals: Record<string, number> = {}
const vertexSets: Float32Array[] = []
let detected = 0
for (const [index, subject] of subjects.entries()) {
  const scene = prepareSubject(model, subject)
  vertexSets.push(scene.vertices)
  const image = renderSubject(model, subject).face
  const result = await detector.detect("face", encodePng(image.width, image.height, image.rgba))
  if (!result.landmarks) {
    console.log(`${subject.id}: no face`)
    continue
  }
  detected++
  for (const [name, score] of Object.entries(result.blendshapes ?? {}))
    blendTotals[name] = (blendTotals[name] ?? 0) + score
  const eyes = scene.meshes[1]!
  const pick = renderPick(scene.vertices, scene.bodyIndices, scene.faceCamera, [eyes])
  for (let landmark = 0; landmark < LANDMARKS; landmark++) {
    const x = Math.floor(result.landmarks[landmark * 3]! * pick.width)
    const y = Math.floor(result.landmarks[landmark * 3 + 1]! * pick.height)
    if (x < 0 || y < 0 || x >= pick.width || y >= pick.height) continue
    const triangle = pick.triangle[y * pick.width + x]!
    if (triangle < 0) continue
    hits[landmark] = hits[landmark]! + 1
    const point: [number, number, number] = [0, 0, 0]
    for (let corner = 0; corner < 3; corner++) {
      const vertex = scene.bodyIndices[triangle * 3 + corner]!
      const weight = pick.weights[(y * pick.width + x) * 3 + corner]!
      maps[landmark]!.set(vertex, (maps[landmark]!.get(vertex) ?? 0) + weight)
      for (let axis = 0; axis < 3; axis++) point[axis] = point[axis]! + weight * scene.vertices[vertex * 3 + axis]!
    }
    picked.push({ subject: index, landmark, point })
  }
  console.log(`${subject.id}: ${String(result.ms.toFixed(0))} ms`)
}
await detector.close()
void supersample
const landmarks = maps.map((map, landmark) => {
  const top = [...map.entries()].toSorted((a, b) => b[1] - a[1]).slice(0, 6)
  const total = top.reduce((sum, [, weight]) => sum + weight, 0)
  return {
    v: top.map(([vertex]) => vertex),
    w: top.map(([, weight]) => Math.round((weight / total) * 1e4) / 1e4),
    hits: hits[landmark]!,
  }
})
// Spread: distance between each subject's picked point and the averaged map's point on that subject's mesh.
const squared = new Float64Array(LANDMARKS)
const samples = new Int32Array(LANDMARKS)
for (const { subject, landmark, point } of picked) {
  const entry = landmarks[landmark]!
  const vertices = vertexSets[subject]!
  const predicted = [0, 0, 0]
  entry.v.forEach((vertex, k) => {
    for (let axis = 0; axis < 3; axis++) predicted[axis] = predicted[axis]! + entry.w[k]! * vertices[vertex * 3 + axis]!
  })
  squared[landmark] =
    squared[landmark]! +
    (predicted[0]! - point[0]) ** 2 +
    (predicted[1]! - point[1]) ** 2 +
    (predicted[2]! - point[2]) ** 2
  samples[landmark] = samples[landmark]! + 1
}
const output = {
  format: "eskais-face-landmarks/1",
  note: "MediaPipe Face Landmarker (478) on Anny's mesh: vertex ids, barycentric weights, spread in mm. Calibrated on synthetic renders (tooling/calibrate/face-landmarks.ts).",
  subjects: count,
  detected,
  blendshapeBaseline: Object.fromEntries(
    Object.entries(blendTotals).map(([name, total]) => [name, Math.round((total / Math.max(detected, 1)) * 1e4) / 1e4]),
  ),
  landmarks: landmarks.map((entry, landmark) => ({
    ...entry,
    spreadMm: samples[landmark]! > 0 ? Math.round(Math.sqrt(squared[landmark]! / samples[landmark]!) * 1e4) / 10 : null,
  })),
}
writeFileSync(join(import.meta.dirname, "../../assets/anny/face-landmarks.json"), JSON.stringify(output) + "\n")
const spreads = output.landmarks
  .map((entry) => entry.spreadMm)
  .filter((value): value is number => value !== null)
  .toSorted((a, b) => a - b)
console.log(
  `detected ${String(detected)}/${String(count)}; mapped ${String(spreads.length)}/478; spread median ${String(spreads[spreads.length >> 1])} mm, p90 ${String(spreads[Math.floor(spreads.length * 0.9)])} mm`,
)
