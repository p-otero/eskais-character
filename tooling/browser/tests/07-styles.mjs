// Every style renders through the reference three.js materials (WebGL on SwiftShader), and restyle re-exports a
// scanned character with another style and hair without the photo.
import assert from "node:assert/strict"
import { validateGlb } from "../../validate-glb.mjs"
import { fixture, manifest } from "../fixtures.mjs"
import { openPage, root } from "../serve.mjs"

export async function everyStyleRendersAndRestyleWorks() {
  const { browser, page } = await openPage(`${root}/.cache/harness`)
  try {
    await page.evaluate(() => globalThis.harness.init("CPU", "full"))
    const subject = manifest.subjects[3]
    const images = [fixture(subject.id, "face"), fixture(subject.id, "body")]
    const scan = await page.evaluate(([face, body]) => globalThis.harness.scan(face, body), images)
    for (const style of ["soft-toon", "cel-outline", "low-poly", "clay"]) {
      const result = await page.evaluate(
        ([glb, id]) => globalThis.harness.renderGlb(glb, id, null, 0, 0, { style: id, hair: "none" }),
        [scan.glb, style],
      )
      assert.ok(result.covered > 20_000, `${style} draws the character (${String(result.covered)} pixels)`)
    }
    const restyled = await page.evaluate(() =>
      globalThis.harness.restyleLast({ style: "cel-outline", stylize: 1, outfit: "hoodie" }),
    )
    assert.equal(restyled.look.style, "cel-outline")
    assert.equal(restyled.look.outfit, "hoodie")
    const { errors } = await validateGlb(new Uint8Array(restyled.glb))
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
}
