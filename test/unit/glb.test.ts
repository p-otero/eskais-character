import { validateBytes } from "gltf-validator"
import { describe, expect, it } from "vitest"
import { bodyCoefficients, evaluateShape, type Phenotype } from "../../src/model/anny.ts"
import { morphTargetNames, morphWeights, writeCharacterGlb, type CharacterColors } from "../../src/model/glb.ts"
import { hairStyle } from "../../src/model/hair.ts"
import { loadAnny } from "../load-anny.ts"

interface Accessor {
  bufferView?: number
  byteOffset?: number
  componentType: number
  normalized?: boolean
  count: number
  type: string
  sparse?: { count: number; indices: { bufferView: number; componentType: number }; values: { bufferView: number } }
}
interface Gltf {
  meshes: {
    name: string
    weights?: number[]
    extras?: { targetNames?: string[] }
    primitives: { attributes: Record<string, number>; targets?: { POSITION: number }[] }[]
  }[]
  skins: { joints: number[] }[]
  accessors: Accessor[]
  bufferViews: { byteOffset?: number; byteLength: number; byteStride?: number }[]
}

function parseGlb(glb: Uint8Array): { json: Gltf; bin: Uint8Array } {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength)
  expect(view.getUint32(0, true)).toBe(0x46546c67)
  expect(view.getUint32(4, true)).toBe(2)
  expect(view.getUint32(8, true)).toBe(glb.byteLength)
  const jsonLength = view.getUint32(12, true)
  expect(view.getUint32(16, true)).toBe(0x4e4f534a)
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength))) as Gltf
  const binLength = view.getUint32(20 + jsonLength, true)
  expect(view.getUint32(24 + jsonLength, true)).toBe(0x004e4942)
  return { json, bin: glb.subarray(28 + jsonLength, 28 + jsonLength + binLength) }
}

function readVec3(json: Gltf, bin: Uint8Array, index: number): Float32Array {
  const accessor = json.accessors[index]!
  const out = new Float32Array(accessor.count * 3)
  const decode = (viewIndex: number, count: number, componentType: number, normalized: boolean) => {
    const view = json.bufferViews[viewIndex]!
    const start = bin.byteOffset + (view.byteOffset ?? 0)
    if (componentType === 5126) return new Float32Array(bin.buffer.slice(start, start + count * 12))
    const stride = (view.byteStride ?? 6) / 2
    const shorts = new Int16Array(bin.buffer.slice(start, start + count * stride * 2))
    const values = new Float32Array(count * 3)
    for (let i = 0; i < count; i++)
      for (let axis = 0; axis < 3; axis++) {
        const value = shorts[i * stride + axis]!
        values[i * 3 + axis] = normalized ? Math.max(value / 32767, -1) : value
      }
    return values
  }
  if (accessor.bufferView !== undefined)
    out.set(decode(accessor.bufferView, accessor.count, accessor.componentType, accessor.normalized ?? false))
  if (accessor.sparse) {
    const view = json.bufferViews[accessor.sparse.indices.bufferView]!
    const start = bin.byteOffset + (view.byteOffset ?? 0)
    const indices = new Uint16Array(bin.buffer.slice(start, start + accessor.sparse.count * 2))
    const values = decode(
      accessor.sparse.values.bufferView,
      accessor.sparse.count,
      accessor.componentType,
      accessor.normalized ?? false,
    )
    indices.forEach((vertex, i) => out.set(values.subarray(i * 3, i * 3 + 3), vertex * 3))
  }
  return out
}

const colors: CharacterColors = {
  skin: [200, 150, 120],
  eyes: [70, 110, 160],
  hair: [50, 34, 24],
  brows: [40, 27, 19],
  beard: [45, 30, 22],
}
const phenotype: Phenotype = { gender: 0.3, age: 0.75, muscle: 0.6, weight: 0.4, height: 0.7, proportions: 0.45 }

describe("writeCharacterGlb", () => {
  const model = loadAnny()
  const body = bodyCoefficients(model, phenotype)
  const face = model.faceModifierLabels.map((_, index) => ((index * 37) % 13) / 13 - 0.45)
  const outputs = {
    base: writeCharacterGlb({ model, body, face, colors, hair: hairStyle("medium"), mode: "base" }),
    character: writeCharacterGlb({ model, body, face, colors, hair: hairStyle("medium"), mode: "character" }),
  }

  it("writes a GLB with the body, eyes and hair meshes, a 104-joint skin and every morph target", () => {
    for (const [mode, output] of Object.entries(outputs)) {
      const { json } = parseGlb(output.glb)
      expect(json.meshes.map((mesh) => mesh.name)).toEqual(["body", "eyes", "hair"])
      expect(json.skins).toHaveLength(1)
      expect(json.skins[0]!.joints).toHaveLength(104)
      const bodyMesh = json.meshes[0]!
      expect(bodyMesh.primitives[0]!.targets).toHaveLength(morphTargetNames(model).length)
      expect(bodyMesh.extras?.targetNames).toEqual(morphTargetNames(model))
      expect(output.targetNames).toEqual(morphTargetNames(model))
      console.log(
        `${mode} GLB: ${(output.glb.byteLength / 1e6).toFixed(2)} MB, ${String(output.targetNames.length)} morph targets`,
      )
    }
    expect(Array.from(outputs.base.weights).every((weight) => weight === 0)).toBe(true)
    expect(parseGlb(outputs.character.glb).json.meshes[0]!.weights).toEqual(Array.from(outputs.character.weights))
  })

  it("passes the Khronos glTF validator without errors", async () => {
    for (const [mode, output] of Object.entries(outputs)) {
      const report = await validateBytes(new Uint8Array(output.glb), { maxIssues: 50 })
      const codes = [...new Set(report.issues.messages.map((message: { code: string }) => message.code))]
      console.log(
        `${mode}: ${String(report.issues.numErrors)} errors, ${String(report.issues.numWarnings)} warnings ${codes.join(", ")}`,
      )
      if (report.issues.numErrors > 0) console.log(JSON.stringify(report.issues.messages.slice(0, 10), null, 1))
      expect(report.issues.numErrors).toBe(0)
    }
  })

  it("reproduces the fitted shape when its weights are applied to the morph targets", () => {
    const expected = evaluateShape(model, { body, face }).vertices
    const weights = morphWeights(model, body, face)
    const { json, bin } = parseGlb(outputs.character.glb)
    const primitive = json.meshes[0]!.primitives[0]!
    const positions = readVec3(json, bin, primitive.attributes["POSITION"]!)
    primitive.targets!.forEach((target, index) => {
      const weight = weights[index] ?? 0
      if (weight === 0) return
      const delta = readVec3(json, bin, target.POSITION)
      for (let i = 0; i < positions.length; i++) positions[i] = positions[i]! + weight * delta[i]!
    })
    let worst = 0
    for (let i = 0; i < positions.length; i++) worst = Math.max(worst, Math.abs(positions[i]! - expected[i]!))
    console.log(`worst vertex error after quantization: ${(worst * 1000).toFixed(3)} mm`)
    // Quantization: deltas step by 1 m / 32767 ≈ 0.03 mm before weighting.
    expect(worst).toBeLessThan(5e-4)
  })

  it("morphWeights maps face values to the incr/decr targets in the model's evaluation exactly", () => {
    const weights = morphWeights(model, body, face)
    const shape = evaluateShape(model, { body, face }).vertices
    const out = new Float32Array(model.meanVertices)
    const stride = model.vertexCount * 3
    for (let k = 0; k < model.bodyRank; k++)
      for (let i = 0; i < stride; i++) out[i] = out[i]! + weights[k]! * model.bodyBasisVertices[k * stride + i]!
    const subset = model.headSubset
    for (let target = 0; target < model.faceModifierLabels.length * 2; target++) {
      const weight = weights[model.bodyRank + target]!
      for (let local = 0; local < subset.length; local++)
        for (let axis = 0; axis < 3; axis++)
          out[subset[local]! * 3 + axis] =
            out[subset[local]! * 3 + axis]! +
            weight * model.faceModifiers[target * subset.length * 3 + local * 3 + axis]!
    }
    let worst = 0
    for (let i = 0; i < out.length; i++) worst = Math.max(worst, Math.abs(out[i]! - shape[i]!))
    expect(worst).toBeLessThan(1e-5)
  })
})
