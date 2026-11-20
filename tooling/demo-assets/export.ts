// Demo assets for the UI library's ModelScan / ModelViewer docs, from a synthetic person (never a real one): a real
// scan of the committed fixture recorded as a replayable event stream, and compact character GLBs in two styles with
// an idle and a wave clip. Usage: bun tooling/demo-assets/export.ts [--subject=s001]
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import { bodyCoefficients } from "../../src/model/anny.ts"
import { writeCharacterGlb, type CompactOptions, type Rgb } from "../../src/model/glb.ts"
import { hairStyle } from "../../src/model/hair.ts"
import { stylePresets, type StyleId } from "../../src/model/style.ts"
import { loadAnny } from "../../test/load-anny.ts"
import { loadHair } from "../../test/load-hair.ts"
import { buildHarness } from "../browser/build-harness.mjs"
import { openPage, root } from "../browser/serve.mjs"
import { validateGlb } from "../validate-glb.mjs"
import type { SynthManifest } from "../synth/generate.ts"

const subjectId = process.argv.find((arg) => arg.startsWith("--subject="))?.slice(10) ?? "s001"
const out = join(root, "demo-assets")
const fixtures = join(root, "fixtures/synthetic")
const manifest = JSON.parse(readFileSync(join(fixtures, "manifest.json"), "utf8")) as SynthManifest
const subject = manifest.subjects.find((entry) => entry.id === subjectId)
if (!subject) throw new Error(`No fixture subject ${subjectId}.`)
const styles: StyleId[] = ["soft-toon", "cel-outline"]
// The targets the docs need: all of the body's first components, the observable face modifiers, every expression.
const compact: CompactOptions = {
  bodyTargets: 3,
  faceModifiers: ["head-scale-horiz", "eye-trans-out", "mouth-scale-horiz", "chin-height"],
  // The ARKit shapes a docs demo animates: blinks, jaw, smile, frown, brows, pucker, funnel.
  expressions: [
    "eyeBlinkLeft",
    "eyeBlinkRight",
    "jawOpen",
    "mouthSmileLeft",
    "mouthSmileRight",
    "mouthFrownLeft",
    "mouthFrownRight",
    "mouthPucker",
    "mouthFunnel",
    "browInnerUp",
    "browDownLeft",
    "browDownRight",
  ],
}

interface StreamEvent {
  type: string
  at: number
  [key: string]: unknown
}

await buildHarness()
const { browser, page } = await openPage(join(root, ".cache/harness"))
let recorded: {
  events: StreamEvent[]
  character: {
    params: { phenotype: Record<string, number>; face: Record<string, number> }
    colors: Record<string, string | null>
    hair: string
    look: { stylize: number; outfit: "casual" | "hoodie" | "none" }
  }
}
try {
  await page.evaluate(() =>
    (globalThis as never as { harness: { init(a: string, b: string): Promise<unknown> } }).harness.init("CPU", "full"),
  )
  const images = [
    Array.from(readFileSync(join(fixtures, `${subjectId}-face.png`))),
    Array.from(readFileSync(join(fixtures, `${subjectId}-body.png`))),
  ]
  recorded = await page.evaluate(
    ([face, body]) =>
      (globalThis as never as { harness: { scanStream(a: number[], b: number[]): Promise<never> } }).harness.scanStream(
        face!,
        body!,
      ),
    images,
  )
} finally {
  await browser.close()
}

const model = loadAnny()
loadHair()
const model0 = recorded.character
const hex = (value: string): Rgb => [1, 3, 5].map((i) => Number.parseInt(value.slice(i, i + 2), 16)) as Rgb
const colors = {
  skin: hex(model0.colors["skin"]!),
  eyes: hex(model0.colors["eyes"]!),
  hair: hex(model0.colors["hair"]!),
  brows: hex(model0.colors["brows"]!),
  beard: model0.colors["beard"] ? hex(model0.colors["beard"]) : null,
}
mkdirSync(out, { recursive: true })
const report: Record<string, unknown> = {}
let replayNames: string[] = []
let replayScales: Float32Array = new Float32Array()
let fullNames: string[] = []
for (const style of styles) {
  const result = writeCharacterGlb({
    model,
    body: bodyCoefficients(model, model0.params.phenotype as never),
    face: model.faceModifierLabels.map((label) => model0.params.face[label] ?? 0),
    colors,
    hair: hairStyle(model0.hair),
    look: { style: stylePresets[style], stylize: model0.look.stylize, outfit: model0.look.outfit },
    compact,
    clips: ["idle", "wave"],
    mode: "character",
  })
  const file = `character-${style}.glb`
  writeFileSync(join(out, file), result.glb)
  const { errors, warnings } = await validateGlb(result.glb)
  if (errors.length > 0) throw new Error(`${file}: ${JSON.stringify(errors.slice(0, 3))}`)
  report[file] = {
    bytes: result.glb.byteLength,
    gzip: gzipSync(result.glb, { level: 9 }).byteLength,
    warnings: warnings.length,
    targets: result.targetNames.length,
  }
  replayNames = result.targetNames
  replayScales = result.targetScales ?? new Float32Array(replayNames.length).fill(1)
  fullNames = writeCharacterGlb({
    model,
    body: new Float32Array(model.bodyRank),
    face: new Float32Array(32),
    colors,
    hair: hairStyle("none"),
    mode: "base",
  }).targetNames
}

// The stream, with its weights re-aligned to the compact GLBs' targets and multiplied by their scales.
const remap = (weights: number[]) =>
  replayNames.map((name, index) => {
    const full = fullNames.indexOf(name)
    return Math.round((full < 0 ? 0 : (weights[full] ?? 0)) * (replayScales[index] ?? 1) * 1e5) / 1e5
  })
const events = recorded.events.map((event) => {
  if (event.type === "progress") return { ...event, weights: remap(event["weights"] as number[]) }
  if (event.type === "model")
    return { type: "model", at: event.at, glb: "character-soft-toon.glb", targetNames: replayNames }
  if (event.type === "done")
    return {
      type: "done",
      at: event.at,
      character: { glb: "character-soft-toon.glb", ...model0, weights: remap(event["weights"] as number[]) },
    }
  if (event.type === "landmarks")
    return { ...event, points: (event["points"] as number[]).map((value) => Math.round(value * 1e4) / 1e4) }
  return event
})
writeFileSync(
  join(out, "scan-replay.json"),
  JSON.stringify({
    note: "A recorded scan of a synthetic person (tooling/synth, CC0). Weights are aligned with targetNames and already multiplied by targetScales, so they apply to the GLBs here as they are. Mask events carry their bytes base64-encoded in data (row-major, 0-255 person confidence).",
    subject: subjectId,
    targetNames: replayNames,
    targetScales: Array.from(replayScales),
    events,
  }) + "\n",
)

// The synthetic photos, listed in a generator manifest so the image guard re-renders and verifies them.
for (const kind of ["face", "body"] as const)
  copyFileSync(join(fixtures, `${subjectId}-${kind}.png`), join(out, `photo-${kind}.png`))
const images = manifest.images
  .filter((image) => image.subject === subjectId)
  .map((image) => ({ ...image, file: `photo-${image.kind}.png` }))
writeFileSync(
  join(out, "manifest.json"),
  JSON.stringify({ ...manifest, count: 1, subjects: [subject], images }, null, 2) + "\n",
)
writeFileSync(join(out, "sizes.json"), JSON.stringify(report, null, 2) + "\n")
console.log(JSON.stringify(report, null, 2))
