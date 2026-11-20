// Renders every hair style on a few phenotypes, front and back, for a visual check of the bake. Writes PNGs to the
// directory given (keep it outside the repo: the image guard refuses images the synthetic generator didn't make).
// Usage: bun tooling/bake/hair/preview.ts <out-dir> [hair-dir, default assets/hair]
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { bodyCoefficients, evaluateShape, type Phenotype } from "../../../src/model/anny.ts"
import { fitHair, parseHairAsset, type HairManifest } from "../../../src/model/hair.ts"
import { headFrame, meshParts } from "../../../src/model/regions.ts"
import { loadAnny } from "../../../test/load-anny.ts"
import { readFileSync } from "node:fs"
import { encodePng } from "../../synth/png.ts"
import { createFrame, drawMesh, resolve, type Camera } from "../../synth/raster.ts"

const out = process.argv[2]
if (!out) throw new Error("Usage: bun tooling/bake/hair/preview.ts <out-dir>")
mkdirSync(out, { recursive: true })
const model = loadAnny()
const hairDir = process.argv[3] ?? join(import.meta.dirname, "../../../assets/hair")
const bytes = readFileSync(join(hairDir, "hair.bin"))
const asset = parseHairAsset(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  JSON.parse(readFileSync(join(hairDir, "hair.json"), "utf8")) as HairManifest,
)
const phenotypes: Phenotype[] = [
  { gender: 0.1, age: 0.7, muscle: 0.6, weight: 0.5, height: 0.6, proportions: 0.5 },
  { gender: 0.9, age: 0.65, muscle: 0.3, weight: 0.3, height: 0.3, proportions: 0.5 },
  { gender: 0.5, age: 0.9, muscle: 0.5, weight: 0.95, height: 0.5, proportions: 0.2 },
]
const tile = 256
const views = [0, Math.PI * 0.75, Math.PI]
for (const [p, phenotype] of phenotypes.entries()) {
  const { vertices, bones } = evaluateShape(model, { body: bodyCoefficients(model, phenotype) })
  const parts = meshParts(model, vertices)
  const frame = headFrame(model, bones, vertices, parts)
  const kept: number[] = []
  for (let t = 0; t < model.faces.length; t += 3)
    if ((parts[model.faces[t]!] ?? 0) < 2) kept.push(model.faces[t]!, model.faces[t + 1]!, model.faces[t + 2]!)
  const skin = new Float32Array(vertices.length)
  for (let v = 0; v < skin.length; v += 3) skin.set([0.55, 0.38, 0.3], v)
  const styles = asset.manifest.styles
  const sheet = new Uint8Array(styles.length * tile * views.length * tile * 4)
  const width = styles.length * tile
  for (const [s, style] of styles.entries()) {
    const hair = fitHair(asset, style.id, vertices, { doubleSided: true })
    const colors = new Float32Array(hair.positions.length)
    for (let v = 0; v < colors.length / 3; v++) {
      const k = hair.shade?.[v] ?? 1
      colors.set([0.09 * k, 0.05 * k, 0.03 * k], v * 3)
    }
    for (const [r, angle] of views.entries()) {
      const [mx, my, mz] = frame.eyeMid
      const distance = 0.9
      const camera: Camera = {
        eye: [mx + Math.sin(angle) * distance, my - 0.05, mz - 0.03 + Math.cos(angle) * distance],
        target: [mx, my - 0.12, mz - 0.05],
        fovY: 0.6,
        width: tile * 2,
        height: tile * 2,
      }
      const target = createFrame(camera.width, camera.height, () => [0.75, 0.78, 0.82])
      const lights = [
        { direction: [0.4, 0.7, 0.8] as [number, number, number], intensity: 0.9 },
        { direction: [-0.5, 0.2, -0.6] as [number, number, number], intensity: 0.35 },
      ]
      drawMesh(target, { positions: vertices, colors: skin, indices: new Uint16Array(kept) }, camera, lights, 0.3)
      drawMesh(target, { positions: hair.positions, colors, indices: hair.indices }, camera, lights, 0.3)
      const image = resolve(target, 2)
      for (let y = 0; y < tile; y++)
        sheet.set(image.rgba.subarray(y * tile * 4, (y + 1) * tile * 4), ((r * tile + y) * width + s * tile) * 4)
    }
  }
  writeFileSync(join(out, `hair-p${String(p)}.png`), encodePng(width, tile * views.length, sheet))
  console.log(`hair-p${String(p)}.png: ${styles.map((style) => style.id).join(", ")}`)
}
