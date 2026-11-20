import * as fc from "fast-check"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { anchorWeights, bodyCoefficients, evaluateShape, neutralPhenotype } from "../../src/model/anny.ts"
import { initialScanState, reduceScan } from "../../src/react/use-character-scan.ts"
import { deltaE, hex, linearToSrgb, srgbToLinear, type Rgb } from "../../src/scan/colors.ts"
import { boxQuadratic, fitFace, similarity, type FaceLandmarkMap } from "../../src/scan/fit-face.ts"
import { pickHair } from "../../src/scan/hair-pick.ts"
import { loadAnny } from "../load-anny.ts"

const unit = fc.double({ min: -1, max: 1, noNaN: true })

describe("anchorWeights", () => {
  it("is a partition of unity with at most two non-zero weights", () => {
    fc.assert(
      fc.property(fc.double({ min: -1, max: 2, noNaN: true }), (value) => {
        const weights = anchorWeights(value, [-1 / 3, 0, 1 / 3, 2 / 3, 1])
        expect(weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12)
        expect(weights.every((w) => w >= -1e-12)).toBe(true)
        expect(weights.filter((w) => Math.abs(w) > 1e-12).length).toBeLessThanOrEqual(2)
      }),
    )
  })
})

describe("similarity (Horn/Umeyama)", () => {
  it("recovers any rotation, scale and translation from noise-free points", () => {
    fc.assert(
      fc.property(
        fc.tuple(unit, unit, unit, fc.double({ min: -Math.PI, max: Math.PI, noNaN: true })),
        fc.double({ min: 0.1, max: 50, noNaN: true }),
        fc.tuple(unit, unit, unit),
        (axisAngle, scale, translation) => {
          const [ax, ay, az, angle] = axisAngle
          const norm = Math.hypot(ax, ay, az)
          fc.pre(norm > 0.1)
          const [x, y, z] = [ax / norm, ay / norm, az / norm]
          const c = Math.cos(angle)
          const s = Math.sin(angle)
          const r = [
            c + x * x * (1 - c),
            x * y * (1 - c) - z * s,
            x * z * (1 - c) + y * s,
            y * x * (1 - c) + z * s,
            c + y * y * (1 - c),
            y * z * (1 - c) - x * s,
            z * x * (1 - c) - y * s,
            z * y * (1 - c) + x * s,
            c + z * z * (1 - c),
          ]
          const n = 12
          const source = new Float64Array(n * 3)
          const target = new Float64Array(n * 3)
          for (let i = 0; i < n; i++) {
            const p = [Math.sin(i * 1.7), Math.cos(i * 2.3), Math.sin(i * 0.9 + 1)]
            source.set(p, i * 3)
            for (let row = 0; row < 3; row++)
              target[i * 3 + row] =
                scale * (r[row * 3]! * p[0]! + r[row * 3 + 1]! * p[1]! + r[row * 3 + 2]! * p[2]!) + translation[row]!
          }
          const fit = similarity(source, target, new Float64Array(n).fill(1))
          expect(fit.scale).toBeCloseTo(scale, 6)
          fit.rotation.forEach((value, index) => expect(value).toBeCloseTo(r[index]!, 6))
          fit.translation.forEach((value, index) => expect(value).toBeCloseTo(translation[index]!, 6))
        },
      ),
      { numRuns: 200 },
    )
  })
})

describe("boxQuadratic", () => {
  it("stays in the box and satisfies the optimality conditions of a convex quadratic", () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: -2, max: 2, noNaN: true }), { minLength: 16, maxLength: 16 }),
        fc.array(unit, { minLength: 4, maxLength: 4 }),
        (entries, linear) => {
          // G = AᵀA + I is positive definite.
          const n = 4
          const g = new Float64Array(n * n)
          for (let i = 0; i < n; i++)
            for (let j = 0; j < n; j++) {
              let sum = i === j ? 1 : 0
              for (let k = 0; k < n; k++) sum += entries[k * n + i]! * entries[k * n + j]!
              g[i * n + j] = sum
            }
          const h = Float64Array.from(linear)
          const u = new Float64Array(n)
          boxQuadratic(g, h, u, 500)
          for (let i = 0; i < n; i++) {
            expect(u[i]).toBeGreaterThanOrEqual(0)
            expect(u[i]).toBeLessThanOrEqual(1)
            let gradient = -h[i]!
            for (let j = 0; j < n; j++) gradient += g[i * n + j]! * u[j]!
            // KKT: zero gradient inside the box; at a bound the gradient points out of the box.
            const inside = u[i]! > 1e-6 && u[i]! < 1 - 1e-6
            const atLower = u[i]! <= 1e-6
            const violation = inside ? Math.abs(gradient) : atLower ? Math.max(-gradient, 0) : Math.max(gradient, 0)
            expect(violation).toBeLessThan(1e-4)
          }
        },
      ),
    )
  })
})

describe("fitFace", () => {
  it("recovers face modifiers from noise-free landmarks of a known face", () => {
    const model = loadAnny()
    const map = JSON.parse(
      readFileSync(join(import.meta.dirname, "../../assets/anny/face-landmarks.json"), "utf8"),
    ) as FaceLandmarkMap
    const body = bodyCoefficients(model, neutralPhenotype)
    const truth = Float32Array.from(model.faceModifierLabels, (_, index) =>
      index % 3 === 0 ? 0.5 : index % 3 === 1 ? -0.4 : 0,
    )
    const { vertices } = evaluateShape(model, { body, face: truth })
    const landmarks: number[] = []
    for (const entry of map.landmarks) {
      const p = [0, 0, 0]
      entry.v.forEach((vertex, k) => {
        for (let axis = 0; axis < 3; axis++) p[axis] = p[axis]! + entry.w[k]! * vertices[vertex * 3 + axis]!
      })
      landmarks.push(0.5 + p[0]! * 3, 0.5 - (p[1]! - 1.6) * 3, -p[2]! * 3)
    }
    const fit = fitFace(
      model,
      map,
      body,
      { landmarks, blendshapes: map.blendshapeBaseline, width: 640, height: 640 },
      { lambda: 1e-9, iterations: 12 },
    )
    const error = truth.reduce((sum, value, index) => sum + Math.abs(value - fit.face[index]!), 0) / truth.length
    expect(error).toBeLessThan(0.08)
    expect(fit.rmsMm).toBeLessThan(0.5)
  })
})

describe("colours", () => {
  const rgb = fc.tuple(
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 0, max: 255 }),
  ) as fc.Arbitrary<Rgb>
  it("round-trips sRGB through linear light and keeps ΔE symmetric", () => {
    fc.assert(
      fc.property(rgb, rgb, (a, b) => {
        expect(a.map((channel) => linearToSrgb(srgbToLinear(channel)))).toEqual(a)
        expect(deltaE(a, b)).toBeCloseTo(deltaE(b, a), 9)
        expect(hex(a)).toMatch(/^#[0-9a-f]{6}$/)
      }),
    )
  })

  it("picks hair by the visible shape", () => {
    const base = { hair: [40, 30, 20] as Rgb, hairShape: { coverage: 0.8, crown: 0.5, fall: 0 } }
    expect(pickHair({ ...base, hair: null })).toBe("none")
    expect(pickHair(base)).toBe("buzz")
    expect(pickHair({ ...base, hairShape: { ...base.hairShape, fall: 0.15 } })).toBe("crop")
    expect(pickHair({ ...base, hairShape: { ...base.hairShape, fall: 0.5 } })).toBe("fringe-bob")
    expect(pickHair({ ...base, hairShape: { ...base.hairShape, fall: 1.6 } })).toBe("long")
  })
})

describe("reduceScan", () => {
  it("maps the event stream to props", () => {
    let state = reduceScan(initialScanState, { type: "start" })
    state = reduceScan(state, { type: "event", event: { type: "stage", stage: "detect-face" } })
    expect(state.stage).toBe("detect-face")
    const points = new Float32Array([0.5, 0.5])
    state = reduceScan(state, { type: "event", event: { type: "landmarks", source: "face", points, aspect: 1 } })
    expect(state.landmarks.face).toBe(points)
    const weights = new Float32Array([0.1, 0.2])
    state = reduceScan(state, { type: "event", event: { type: "progress", value: 0.4, weights } })
    expect(state.progress).toBe(0.4)
    expect(state.weights).toBe(weights)
    state = reduceScan(state, { type: "error", error: new Error("x") })
    expect(state.status).toBe("error")
  })
})

describe("scan errors", () => {
  it("maps failures to stable codes and ends the hook state in error", async () => {
    const { errorCode, ScanError } = await import("../../src/scan/errors.ts")
    const { AssetIntegrityError, AssetLoadError } = await import("../../src/scan/loader.ts")
    const { CapabilityError } = await import("../../src/scan/detect.ts")
    expect(errorCode(new CapabilityError("x"))).toBe("webgl2-unavailable")
    expect(errorCode(new AssetIntegrityError("x"))).toBe("asset-integrity")
    expect(errorCode(new AssetLoadError("x"))).toBe("asset-load")
    expect(errorCode(new ScanError("no-face", "x"))).toBe("no-face")
    expect(errorCode(new TypeError("x"))).toBe("internal")
    const state = reduceScan(reduceScan(initialScanState, { type: "start" }), {
      type: "event",
      event: { type: "error", error: { code: "no-face", message: "No face." } },
    })
    expect(state.status).toBe("error")
    expect((state.error as InstanceType<typeof ScanError>).code).toBe("no-face")
  })
})
