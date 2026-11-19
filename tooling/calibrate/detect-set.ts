// Renders a synthetic set and caches MediaPipe's detections, so fitting can be iterated in Node without a browser.
// Usage: bun tooling/calibrate/detect-set.ts --seed=1 --count=24 [--out=.cache/detections]
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { loadAnny } from "../../test/load-anny.ts"
import { startDetector } from "../browser/detector.ts"
import { encodePng } from "../synth/png.ts"
import { renderSubject } from "../synth/render.ts"
import { makeSubjects } from "../synth/subjects.ts"

const arg = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const seed = Number(arg("seed", "1"))
const count = Number(arg("count", "24"))
const out = join(arg("out", ".cache/detections"), `seed-${String(seed)}`)
const faceOnly = process.argv.includes("--face-only")
mkdirSync(out, { recursive: true })
const model = loadAnny()
const detector = await startDetector()
for (const subject of makeSubjects(model, count, seed)) {
  const images = renderSubject(model, subject)
  if (faceOnly) {
    const facePng = encodePng(images.face.width, images.face.height, images.face.rgba)
    const face = await detector.detect("face", facePng)
    writeFileSync(
      join(out, `${subject.id}.json`),
      JSON.stringify({ subject, face, faceSize: [images.face.width, images.face.height] }),
    )
    continue
  }
  const facePng = encodePng(images.face.width, images.face.height, images.face.rgba)
  const bodyPng = encodePng(images.body.width, images.body.height, images.body.rgba)
  writeFileSync(join(out, `${subject.id}-face.png`), facePng)
  writeFileSync(join(out, `${subject.id}-body.png`), bodyPng)
  const face = await detector.detect("face", facePng)
  const body = await detector.detect("body", bodyPng)
  writeFileSync(
    join(out, `${subject.id}.json`),
    JSON.stringify({
      subject,
      face,
      body,
      faceSize: [images.face.width, images.face.height],
      bodySize: [images.body.width, images.body.height],
    }),
  )
  console.log(subject.id, face.landmarks ? "face" : "-", body.landmarks ? "body" : "-")
}
await detector.close()
