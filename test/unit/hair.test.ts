import { describe, expect, it } from "vitest"
import { bodyCoefficients, evaluateShape, neutralPhenotype, type Phenotype } from "../../src/model/anny.ts"
import { buildHair, fitHair, hairCatalogue, hairStyle } from "../../src/model/hair.ts"
import { headFrame, meshParts } from "../../src/model/regions.ts"
import { loadAnny } from "../load-anny.ts"
import { loadHair } from "../load-hair.ts"

const model = loadAnny()
const asset = loadHair()
const varied: Phenotype = { gender: 0.05, age: 0.95, muscle: 0.9, weight: 0.95, height: 0.05, proportions: 0.9 }

function shape(phenotype: Phenotype, face?: Float32Array) {
  const { vertices, bones } = evaluateShape(model, {
    body: bodyCoefficients(model, phenotype),
    ...(face ? { face } : {}),
  })
  return { vertices, frame: headFrame(model, bones, vertices, meshParts(model, vertices)) }
}

/** How far each style may reach from the head: long styles hang down the back. */
const reach: Record<string, { below: number; around: number }> = {
  short: { below: 0.12, around: 0.06 },
  medium: { below: 0.2, around: 0.08 },
  long: { below: 0.6, around: 0.12 },
}

function width(positions: Float32Array): number {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (let v = 0; v < positions.length; v += 3) {
    min = Math.min(min, positions[v]!)
    max = Math.max(max, positions[v]!)
  }
  return max - min
}

describe("hair catalogue", () => {
  it("has 6 to 8 fitted CC0 styles across lengths and shapes, plus none and buzz", () => {
    const fitted = hairCatalogue.filter((style) => style.asset)
    expect(fitted.length).toBeGreaterThanOrEqual(6)
    expect(fitted.length).toBeLessThanOrEqual(8)
    expect(new Set(fitted.map((style) => style.length))).toEqual(new Set(["short", "medium", "long"]))
    expect(new Set(fitted.map((style) => style.shape)).size).toBeGreaterThanOrEqual(4)
    for (const style of fitted) expect(asset.styles.has(style.asset ?? "")).toBe(true)
    expect(hairStyle("medium").id).toBe("bob")
  })

  it.each(hairCatalogue.filter((style) => style.asset).map((style) => [style.id, style] as const))(
    "fits %s around the head of the average and a very different body",
    (_, style) => {
      for (const phenotype of [neutralPhenotype, varied]) {
        const { vertices, frame } = shape(phenotype)
        const hair = fitHair(asset, style.asset ?? "", vertices)
        const count = hair.positions.length / 3
        expect(count).toBeGreaterThan(100)
        expect(hair.indices.length / 3).toBeLessThanOrEqual(6000)
        const [mx, my, mz] = frame.eyeMid
        const limits = reach[style.length] ?? reach["long"]!
        let insideSkull = 0
        for (let v = 0; v < count; v++) {
          const x = hair.positions[v * 3]! - mx
          const y = hair.positions[v * 3 + 1]! - my
          const z = hair.positions[v * 3 + 2]! - mz
          // Head box: about 0.2 m wide and deep, from the crown down to the jaw, grown by the style's reach.
          expect(Math.abs(x)).toBeLessThan(0.1 + limits.around + (y < -0.1 ? 0.12 : 0))
          expect(y).toBeLessThan(0.16)
          expect(y).toBeGreaterThan(-0.14 - limits.below)
          expect(z).toBeLessThan(0.12)
          expect(z).toBeGreaterThan(-0.25 - limits.around)
          // The skull's centre sits about 4 cm behind and 3 cm above the eyes; nothing should be within 4 cm of it.
          if (Math.hypot(x, y - 0.03, z + 0.06) < 0.04) insideSkull++
        }
        expect(insideSkull).toBe(0)
      }
    },
  )

  it("follows a larger head", () => {
    const labels = model.faceModifierLabels
    const bigger = Float32Array.from(labels, (label) =>
      label === "head-scale-horiz" || label === "head-scale-vert" ? 1 : 0,
    )
    const plain = shape(neutralPhenotype)
    const big = shape(neutralPhenotype, bigger)
    const a = fitHair(asset, "crop", plain.vertices)
    const b = fitHair(asset, "crop", big.vertices)
    expect(width(b.positions)).toBeGreaterThan(width(a.positions) * 1.02)
  })

  it("duplicates triangles with the opposite winding on request, and buildHair uses the registered asset", () => {
    const { vertices, frame } = shape(neutralPhenotype)
    const single = fitHair(asset, "bob", vertices)
    const double = fitHair(asset, "bob", vertices, { doubleSided: true })
    expect(double.indices.length).toBe(single.indices.length * 2)
    expect(double.positions.length).toBe(single.positions.length * 2)
    const built = buildHair(
      hairStyle("bob"),
      vertices,
      new Float32Array(vertices.length),
      model.faces,
      new Uint8Array(model.vertexCount),
      frame,
    )
    expect(built.positions).toEqual(single.positions)
    expect(
      buildHair(hairStyle("none"), vertices, vertices, model.faces, new Uint8Array(model.vertexCount), frame).indices
        .length,
    ).toBe(0)
  })
})
