import { readFileSync } from "node:fs"
import { join } from "node:path"
import { root } from "./serve.mjs"

const dir = join(root, "fixtures/synthetic")
export const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))

/** A committed synthetic image as a plain byte array, ready to pass into page.evaluate. */
export function fixture(subject, kind) {
  return Array.from(readFileSync(join(dir, `${subject}-${kind}.png`)))
}
