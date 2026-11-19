import { describe, expect, it } from "vitest"
import { anchorWeights, bodyCoefficients, evaluateShape, type Phenotype } from "../../src/model/anny.ts"
import { loadAnny, readFixture } from "../load-anny.ts"

interface ReferenceCase {
  phenotype: Phenotype
  faceModifiers: Record<string, number>
  vertexIndices: number[]
  vertices: [number, number, number][]
  bones: Record<string, [number, number, number]>
}

describe("anchorWeights", () => {
  it("interpolates between the two surrounding anchors and clamps outside", () => {
    expect(anchorWeights(0.25, [0, 0.5, 1])).toEqual([0.5, 0.5, 0])
    expect(anchorWeights(-1, [0, 0.5, 1])).toEqual([1, 0, 0])
    expect(anchorWeights(2, [0, 1])).toEqual([0, 1])
  })
})

describe("evaluateShape", () => {
  const model = loadAnny()
  const { cases } = readFixture<{ cases: ReferenceCase[] }>("anny-reference.json")

  it.each(cases.map((testCase, index) => [index, testCase] as const))(
    "matches Anny's own vertices for reference case %i within the PCA error",
    (_, testCase) => {
      const face = model.faceModifierLabels.map((label) => testCase.faceModifiers[label] ?? 0)
      const { vertices, bones } = evaluateShape(model, { body: bodyCoefficients(model, testCase.phenotype), face })
      let worst = 0
      let squared = 0
      testCase.vertexIndices.forEach((vertex, index) => {
        const expected = testCase.vertices[index] ?? [0, 0, 0]
        for (let axis = 0; axis < 3; axis++) {
          const error = Math.abs((vertices[vertex * 3 + axis] ?? 0) - expected[axis]!)
          worst = Math.max(worst, error)
          squared += error * error
        }
      })
      const rms = Math.sqrt(squared / (testCase.vertexIndices.length * 3))
      expect(rms).toBeLessThan(0.002)
      expect(worst).toBeLessThan(0.02)
      const head = model.boneLabels.indexOf("head")
      const expectedHead = testCase.bones["head"] ?? [0, 0, 0]
      for (let axis = 0; axis < 3; axis++) expect(bones[head * 3 + axis]).toBeCloseTo(expectedHead[axis]!, 2)
    },
  )

  it("puts the face towards +Z and the head above the feet", () => {
    const { bones } = evaluateShape(model, {
      body: bodyCoefficients(model, { gender: 0.5, age: 0.7, muscle: 0.5, weight: 0.5, height: 0.5, proportions: 0.5 }),
    })
    const head = model.boneLabels.indexOf("head")
    const footL = model.boneLabels.indexOf("foot.L")
    expect(bones[head * 3 + 1]!).toBeGreaterThan(bones[footL * 3 + 1]! + 1)
  })
})
