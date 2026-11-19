import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseAnny, type AnnyManifest, type AnnyModel } from "../src/model/anny.ts"

const root = join(import.meta.dirname, "..")

let cached: AnnyModel | undefined

export function loadAnny(): AnnyModel {
  if (cached) return cached
  const bytes = readFileSync(join(root, "assets/anny/anny.bin"))
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  const manifest = JSON.parse(readFileSync(join(root, "assets/anny/anny.json"), "utf8")) as AnnyManifest
  cached = parseAnny(buffer, manifest)
  return cached
}

export function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(root, "test/fixtures", name), "utf8")) as T
}
