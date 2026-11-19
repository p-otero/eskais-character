import { describe, expect, it } from "vitest"
import { comparePixels } from "../../tooling/check-images.ts"
import { findYoungDependencies } from "../../tooling/check-dependency-age.mjs"
import { forbiddenName, licenceAllowed } from "../../tooling/check-licences.mjs"
import { lockfileProblems, parseBunLock } from "../../tooling/check-lockfile.mjs"

const day = 24 * 60 * 60 * 1000

describe("licence allow-list", () => {
  it("accepts permissive licences and SPDX expressions made of them", () => {
    expect(licenceAllowed("MIT")).toBe(true)
    expect(licenceAllowed("(MIT OR GPL-3.0)")).toBe(true)
    expect(licenceAllowed("Apache-2.0 AND CC0-1.0")).toBe(true)
  })

  it("refuses copyleft, unknown and mixed-in copyleft licences", () => {
    expect(licenceAllowed("GPL-3.0-or-later")).toBe(false)
    expect(licenceAllowed("MPL-2.0")).toBe(false)
    expect(licenceAllowed("UNKNOWN")).toBe(false)
    expect(licenceAllowed("MIT AND CC-BY-NC-4.0")).toBe(false)
  })

  it("flags the SMPL and Max Planck family by name", () => {
    for (const name of ["smplx", "SMPL-X", "flame-model", "deca", "emoca", "shapy", "amass-loader"])
      expect(forbiddenName.test(name)).toBe(true)
    for (const name of ["three", "@mediapipe/tasks-vision", "anny", "micromatch"])
      expect(forbiddenName.test(name)).toBe(false)
  })
})

describe("dependency age", () => {
  const now = Date.parse("2026-11-19T00:00:00Z")
  const published = new Map([
    ["a@1.0.0", new Date(now - 10 * day).toISOString()],
    ["b@2.0.0", new Date(now - 2 * day).toISOString()],
  ])

  it("passes old exact pins and fails young ones, ranges and loose git specs", () => {
    const { problems } = findYoungDependencies(
      ["a@1.0.0", "b@2.0.0", "c@^1.0.0", "d@github:o/r#main", `e@github:o/r#${"a".repeat(40)}`],
      published,
      now,
      { exceptions: {} },
    )
    expect(problems.map((problem) => problem.spec)).toEqual(["b@2.0.0", "c@^1.0.0", "d@github:o/r#main"])
  })

  it("allows a listed young exception and says when it has matured", () => {
    expect(findYoungDependencies(["b@2.0.0"], published, now, { exceptions: { "b@2.0.0": "why" } }).problems).toEqual(
      [],
    )
    expect(findYoungDependencies(["a@1.0.0"], published, now, { exceptions: { "a@1.0.0": "why" } }).matured).toEqual([
      "a@1.0.0",
    ])
  })
})

describe("lockfile check", () => {
  const lock = parseBunLock(`{
    "workspaces": { "": { "dependencies": { "a": "1.0.0", }, }, },
    "packages": { "a": ["a@1.0.0", "", {}, "sha512-x"], },
  }`)

  it("accepts a lockfile in step with package.json and the install", () => {
    expect(lockfileProblems({ dependencies: { a: "1.0.0" } }, lock, () => "1.0.0")).toEqual([])
  })

  it("reports ranges, drift and stale installs", () => {
    expect(lockfileProblems({ dependencies: { a: "^1.0.0" } }, lock, () => "1.0.0").length).toBeGreaterThan(0)
    expect(lockfileProblems({ dependencies: { a: "1.0.1" } }, lock, () => "1.0.1").length).toBeGreaterThan(0)
    expect(lockfileProblems({ dependencies: { a: "1.0.0" } }, lock, () => "0.9.0")).toHaveLength(1)
  })
})

describe("image re-render comparison", () => {
  it("tolerates rounding differences but not a different picture", () => {
    const a = new Uint8Array(4000).fill(100)
    const close = a.map((value, index) => (index % 7 === 0 ? value + 2 : value))
    expect(comparePixels(a, close).share).toBe(1)
    const different = a.map((value, index) => (index < 400 ? value + 50 : value))
    expect(comparePixels(a, different).share).toBeLessThan(0.999)
    expect(comparePixels(a, new Uint8Array(8)).share).toBe(0)
  })
})
