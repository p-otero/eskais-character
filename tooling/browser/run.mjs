// Browser tests in real Chrome (system Chrome, else Playwright's Chromium), WebGL through SwiftShader.
// Usage: node tooling/browser/run.mjs [--no-build] [--only=<file prefix>]. Runs each export of tooling/browser/tests/*.mjs.
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { buildHarness } from "./build-harness.mjs"

if (!process.argv.includes("--no-build")) await buildHarness()
const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice(7)
const dir = join(import.meta.dirname, "tests")
let failed = 0
for (const file of readdirSync(dir)
  .filter((name) => name.endsWith(".mjs") && (!only || name.startsWith(only)))
  .toSorted()) {
  const tests = await import(pathToFileURL(join(dir, file)).href)
  for (const [name, test] of Object.entries(tests)) {
    const started = performance.now()
    try {
      await test()
      console.log(`ok ${file} > ${name} (${(performance.now() - started).toFixed(0)} ms)`)
    } catch (error) {
      failed++
      console.error(
        `FAIL ${file} > ${name}\n  ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      )
    }
  }
}
if (failed > 0) {
  console.error(`${String(failed)} browser test(s) failed.`)
  process.exitCode = 1
}
