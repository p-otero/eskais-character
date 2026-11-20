import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { pinnedAssets } from "../../src/scan/assets.ts"
import { packageVersion } from "../../src/version.ts"

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "../../package.json"), "utf8")) as {
  version: string
}

describe("package", () => {
  it("pins the CDN fallback of its own assets to its own version", () => {
    expect(packageVersion).toBe(manifest.version)
    expect(pinnedAssets.annyModel.url).toContain(`eskais-character@${manifest.version}/assets/`)
    expect(pinnedAssets.hairModel.url).toContain(`eskais-character@${manifest.version}/assets/`)
  })
})
