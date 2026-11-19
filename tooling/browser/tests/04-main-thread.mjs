// Everything heavy runs in the worker: no main-thread task over 50 ms while a scan runs.
import assert from "node:assert/strict"
import { fixture, manifest } from "../fixtures.mjs"
import { openPage, root } from "../serve.mjs"

export async function noLongTasksDuringAScan() {
  const { browser, page } = await openPage(`${root}/.cache/harness`)
  try {
    await page.evaluate(() => globalThis.harness.init("CPU", "full"))
    const subject = manifest.subjects[2]
    const images = [fixture(subject.id, "face"), fixture(subject.id, "body")]
    await page.evaluate(() => globalThis.harness.resetLongTasks())
    await page.evaluate(([face, body]) => globalThis.harness.scan(face, body, undefined, true), images)
    const longTasks = await page.evaluate(() => globalThis.harness.longTasks())
    const over = longTasks.filter((ms) => ms > 50)
    assert.deepEqual(over, [], `main-thread long tasks: ${longTasks.map((ms) => ms.toFixed(0)).join(", ")}`)
  } finally {
    await browser.close()
  }
}
