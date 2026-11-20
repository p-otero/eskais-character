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
    // A person mask per photo, each after its landmarks, small, with the photo's aspect, and covering some of it.
    for (const source of ["face", "body"]) {
      const maskAt = result.events.findIndex((event) => event.type === "mask" && event.detail.source === source)
      const landmarksAt = result.events.findIndex(
        (event) => event.type === "landmarks" && event.detail.source === source,
      )
      assert.ok(maskAt > landmarksAt && landmarksAt >= 0, `${source} mask after its landmarks`)
      const { width, height, mean } = result.events[maskAt].detail
      const { aspect } = result.events[landmarksAt].detail
      assert.equal(Math.max(width, height), 256)
      assert.ok(Math.abs(width / height - aspect) < 0.02, `${source} mask keeps the photo's aspect`)
      assert.ok(mean > 10 && mean < 245, `${source} mask is neither empty nor full (${String(mean)})`)
    }
    const { errors, warnings } = await validateGlb(new Uint8Array(result.glb))
    assert.deepEqual(errors, [], "the Khronos glTF validator reports no errors")
    assert.deepEqual(warnings, [], "nor warnings")
    assert.match(result.colors.skin, /^#[0-9a-f]{6}$/)
  } finally {
    await browser.close()
  }
}
