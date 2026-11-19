// The worker starts, MediaPipe's WASM loads from verified blob URLs, and one face is detected.
import assert from "node:assert/strict"
import { fixture, manifest } from "../fixtures.mjs"
import { openPage, root } from "../serve.mjs"

export async function workerAndWasmSmoke() {
  const { browser, page } = await openPage(`${root}/.cache/harness`)
  try {
    const ready = await page.evaluate(() => globalThis.harness.init("CPU", "lite"))
    assert.equal(ready.delegate, "CPU")
    const bytes = fixture(manifest.subjects[0].id, "face")
    const result = await page.evaluate((png) => globalThis.harness.detect("face", png), bytes)
    assert.equal(result.landmarks?.length, 478 * 3)
    assert.ok(Object.keys(result.blendshapes ?? {}).length >= 52)
  } finally {
    await browser.close()
  }
}
