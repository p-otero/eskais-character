// Failures surface as a final error event with a stable code, not as a rejected iterator.
import assert from "node:assert/strict"
import { openPage, root } from "../serve.mjs"

export async function noFaceEndsWithAnErrorEvent() {
  const { browser, page } = await openPage(`${root}/.cache/harness`)
  try {
    await page.evaluate(() => globalThis.harness.init("CPU", "lite"))
    const events = await page.evaluate(() => globalThis.harness.scanBlank())
    const last = events.at(-1)
    assert.equal(last.type, "error")
    assert.equal(last.error.code, "no-face")
    assert.ok(!events.some((event) => event.type === "done"))
  } finally {
    await browser.close()
  }
}
