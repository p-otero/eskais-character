import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseHairAsset, registerHairAsset, type HairAsset, type HairManifest } from "../src/model/hair.ts"

const root = join(import.meta.dirname, "..")
let cached: HairAsset | undefined

/** The baked hair asset from disk, registered for buildHair (tests and tooling). */
export function loadHair(): HairAsset {
  if (cached) return cached
  const bytes = readFileSync(join(root, "assets/hair/hair.bin"))
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  const manifest = JSON.parse(readFileSync(join(root, "assets/hair/hair.json"), "utf8")) as HairManifest
  cached = parseHairAsset(buffer, manifest)
  registerHairAsset(cached)
  return cached
}
