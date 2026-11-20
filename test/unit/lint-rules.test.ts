import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const root = join(import.meta.dirname, "..", "..")
const oxlint = join(root, "node_modules", "oxlint", "bin", "oxlint")
let project = ""

// The overrides in .oxlintrc.json match paths relative to the project, so the fixtures get their own project with the
// repo's config, its relative plugin paths made absolute.
beforeAll(() => {
  project = mkdtempSync(join(tmpdir(), "character-lint-"))
  const config = JSON.parse(readFileSync(join(root, ".oxlintrc.json"), "utf8")) as Record<string, unknown>
  const absolute = (paths: unknown) => (paths as string[]).map((path) => join(root, path))
  config["extends"] = absolute(config["extends"])
  config["jsPlugins"] = absolute(config["jsPlugins"])
  delete config["$schema"]
  writeFileSync(join(project, ".oxlintrc.json"), JSON.stringify(config))
})

afterAll(() => {
  rmSync(project, { recursive: true, force: true })
})

function lint(files: Record<string, string>): string[] {
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(dirname(join(project, file)), { recursive: true })
    writeFileSync(join(project, file), source)
  }
  let output = ""
  try {
    output = execFileSync(process.execPath, [oxlint, "-c", ".oxlintrc.json", "-f", "unix", ...Object.keys(files)], {
      cwd: project,
      encoding: "utf8",
    })
  } catch (error) {
    output = String((error as { stdout?: string }).stdout ?? "")
  }
  for (const file of Object.keys(files)) rmSync(join(project, file))
  return [...output.matchAll(/character\(([\w-]+)\)/g)].map((match) => match[1] ?? "")
}

describe("character oxlint rules", () => {
  it("forbids console in runtime code but not in tooling", () => {
    expect(lint({ "src/a.ts": "console.log(1)\n" })).toContain("no-console")
    expect(lint({ "tooling/a.ts": "console.log(1)\n" })).not.toContain("no-console")
  })

  it("allows network access only in the pinned asset loader", () => {
    const source = 'export const get = () => fetch("https://example.test/a.task")\n'
    expect(lint({ "src/scan/detect.ts": source })).toContain("no-network-outside-loader")
    expect(lint({ "src/scan/loader.ts": source })).not.toContain("no-network-outside-loader")
    expect(lint({ "src/a.ts": "export const w = new WebSocket('wss://x.test')\n" })).toContain(
      "no-network-outside-loader",
    )
    expect(lint({ "src/a.ts": "navigator.sendBeacon('/x', '1')\n" })).toContain("no-network-outside-loader")
    expect(lint({ "src/a.ts": "export const m = (u: string) => import(u)\n" })).toContain("no-network-outside-loader")
    expect(lint({ "src/a.ts": 'export const m = () => import("./b.ts")\n' })).not.toContain("no-network-outside-loader")
    expect(lint({ "src/a.ts": "export const o = { fetch: 1 }\nexport const v = o.fetch\n" })).not.toContain(
      "no-network-outside-loader",
    )
  })

  it("forbids Node and Bun modules in runtime code", () => {
    expect(lint({ "src/a.ts": 'import { readFileSync } from "node:fs"\nexport { readFileSync }\n' })).toContain(
      "no-node-builtins",
    )
    expect(lint({ "src/a.ts": 'import { file } from "bun"\nexport { file }\n' })).toContain("no-node-builtins")
    expect(lint({ "src/a.ts": 'import path from "path"\nexport { path }\n' })).toContain("no-node-builtins")
    expect(lint({ "tooling/a.ts": 'import path from "node:path"\nexport { path }\n' })).not.toContain(
      "no-node-builtins",
    )
  })

  it("forbids image data in worker messages outside the engine", () => {
    const source = "export const send = (b: ImageBitmap) => self.postMessage({ type: 'x', data: { bitmap: b } })\n"
    expect(lint({ "src/scan/worker.ts": source })).toContain("no-image-data-in-messages")
    expect(lint({ "src/scan/engine.ts": source })).not.toContain("no-image-data-in-messages")
    expect(lint({ "src/scan/worker.ts": "self.postMessage({ type: 'progress', value: 0.5 })\n" })).not.toContain(
      "no-image-data-in-messages",
    )
  })
})
