// A full scan on a synthetic person: event order, live weights, and a GLB the Khronos validator accepts.
import assert from "node:assert/strict"
import { validateGlb } from "../../validate-glb.mjs"
import { fixture, manifest } from "../fixtures.mjs"
import { openPage, root } from "../serve.mjs"

export async function scanStreamsEventsAndAValidGlb() {
  const { browser, page } = await openPage(`${root}/.cache/harness`)
  try {
    await page.evaluate(() => globalThis.harness.init("CPU", "full"))
    const subject = manifest.subjects[0]
    const images = [fixture(subject.id, "face"), fixture(subject.id, "body")]
    const result = await page.evaluate(([face, body]) => globalThis.harness.scan(face, body), images)
    const types = result.events.map((event) => event.type)
    assert.ok(types.indexOf("landmarks") < types.indexOf("model"), "landmarks come before the model")
    assert.ok(types.indexOf("model") < types.indexOf("progress"), "the model comes before progress")
    assert.equal(types.at(-1), "done")
    assert.ok(types.filter((type) => type === "progress").length >= 10, "progress streams while fitting")
    const progress = result.events.filter((event) => event.type === "progress").map((event) => event.detail.value)
    assert.deepEqual(
      progress,
      progress.toSorted((a, b) => a - b),
      "progress never goes back",
    )
    assert.equal(result.weights.length, result.targetNames.length)
    const { errors, warnings } = await validateGlb(new Uint8Array(result.glb))
    assert.deepEqual(errors, [], "the Khronos glTF validator reports no errors")
    assert.deepEqual(warnings, [], "nor warnings")
    assert.match(result.colors.skin, /^#[0-9a-f]{6}$/)
  } finally {
    await browser.close()
  }
}
