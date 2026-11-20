import { describe, expect, it } from "vitest"
import { bodyCoefficients, evaluateShape, neutralPhenotype } from "../../src/model/anny.ts"
import { buildCharacter, type CharacterColors } from "../../src/model/character.ts"
import { buildClip, clipIds } from "../../src/model/clips.ts"
import { hairStyle } from "../../src/model/hair.ts"
import { rampLevel, styleColor, stylePresets, styleIds } from "../../src/model/style.ts"
import { headScaler, stylizeFace } from "../../src/model/stylize.ts"
import { loadAnny } from "../load-anny.ts"

const colors: CharacterColors = {
  skin: [205, 160, 130],
  eyes: [70, 110, 160],
  hair: [60, 40, 25],
  brows: [50, 32, 20],
  beard: null,
}

describe("styles", () => {
  it("ramps are monotonic in light and bounded", () => {
    for (const id of styleIds) {
      let previous = -1
      for (let x = 0; x <= 1.0001; x += 0.01) {
        const level = rampLevel(stylePresets[id], x)
        expect(level).toBeGreaterThanOrEqual(previous - 1e-9)
        expect(level).toBeLessThanOrEqual(1)
        previous = level
      }
    }
  })
  it("clay greys and tints; the others keep hue", () => {
    const red = [0.6, 0.1, 0.1]
    const clay = styleColor(stylePresets.clay, red)
    expect(clay[0] - clay[2]).toBeLessThan(red[0]! - red[2]!)
    expect(styleColor(stylePresets["soft-toon"], red)[0]).toBeGreaterThan(0.6)
  })
})

describe("stylize", () => {
  const model = loadAnny()
  it("is the identity at 0 and grows the head and eyes at 1", () => {
    const { vertices, bones } = evaluateShape(model, { body: bodyCoefficients(model, neutralPhenotype) })
    const none = headScaler(model, bones, 0)
    expect(none(0.1, 0.9, 0.1)).toEqual([0.1, 0.9, 0.1])
    const full = headScaler(model, bones, 1)
    const head = model.boneLabels.indexOf("head")
    const top = [bones[head * 3]!, bones[head * 3 + 1]! + 0.15, bones[head * 3 + 2]!] as const
    expect(full(...top)[1]).toBeGreaterThan(top[1])
    const foot = model.boneLabels.indexOf("foot.L")
    expect(full(bones[foot * 3]!, bones[foot * 3 + 1]!, bones[foot * 3 + 2]!)[1]).toBe(bones[foot * 3 + 1]!)
    void vertices
    const face = stylizeFace(model, new Float32Array(model.faceModifierLabels.length).fill(0.9), 1)
    expect(Math.max(...face)).toBeLessThanOrEqual(1)
    expect(face[model.faceModifierLabels.indexOf("eye-scale")]).toBe(1)
  })
})

describe("character", () => {
  const model = loadAnny()
  it("dresses the body without moving it far and keeps the outfit off the face", () => {
    const base = {
      model,
      body: bodyCoefficients(model, neutralPhenotype),
      face: new Float32Array(32),
      colors,
      hair: hairStyle("none"),
      mode: "character" as const,
    }
    const plain = buildCharacter({ ...base, look: { style: stylePresets["soft-toon"], stylize: 0, outfit: "none" } })
    const dressed = buildCharacter({
      ...base,
      look: { style: stylePresets["soft-toon"], stylize: 0, outfit: "casual" },
    })
    const a = plain.meshes[0]!.positions
    const b = dressed.meshes[0]!.positions
    let moved = 0
    let worst = 0
    for (let v = 0; v < model.vertexCount; v++) {
      const d = Math.hypot(b[v * 3]! - a[v * 3]!, b[v * 3 + 1]! - a[v * 3 + 1]!, b[v * 3 + 2]! - a[v * 3 + 2]!)
      worst = Math.max(worst, d)
      if (d > 1e-4) moved++
    }
    expect(worst).toBeLessThan(0.03)
    // Torso, legs and feet: about a third of Anny's vertices (hands and the dense head stay skin).
    expect(moved).toBeGreaterThan(model.vertexCount * 0.3)
    const eye = model.boneLabels.indexOf("eye.L")
    const eyeY = plain.bones[eye * 3 + 1]!
    let faceMoved = 0
    for (let v = 0; v < model.vertexCount; v++)
      if (a[v * 3 + 1]! > eyeY - 0.05) faceMoved = Math.max(faceMoved, Math.abs(b[v * 3 + 1]! - a[v * 3 + 1]!))
    expect(faceMoved).toBeLessThan(1e-6)
  })
})

describe("clips", () => {
  const model = loadAnny()
  const { bones } = evaluateShape(model, { body: bodyCoefficients(model, neutralPhenotype) })
  const rig = { boneLabels: model.boneLabels, bones }

  it("are unit, sign-continuous quaternions, one per key", () => {
    for (const id of clipIds) {
      const clip = buildClip(id, rig)
      for (const track of clip.tracks) {
        expect(track.rotations).toHaveLength(clip.times.length)
        for (const q of track.rotations) expect(Math.hypot(...q)).toBeCloseTo(1, 9)
        // Neighbouring keys in one hemisphere: linear interpolation never takes the long way round.
        const dots = track.rotations
          .slice(1)
          .map((q, index) => q.reduce((sum, value, k) => sum + value * (track.rotations[index]![k] ?? 0), 0))
        expect(Math.min(...dots)).toBeGreaterThan(0.9)
      }
    }
  })

  it("the wave starts and ends at rest, so it loops and crossfades cleanly", () => {
    const clip = buildClip("wave", rig)
    for (const track of clip.tracks)
      for (const q of [track.rotations[0]!, track.rotations.at(-1)!]) expect(Math.abs(q[3]!)).toBeCloseTo(1, 6)
  })
})
