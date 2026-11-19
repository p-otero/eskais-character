// Privacy: a scan makes no request at all once the models are loaded, and every request the page ever makes is a
// body-less GET of the app itself or of a pinned asset URL. Image bytes never leave the page.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fixture, manifest } from "../fixtures.mjs"
import { openPage, origin, root } from "../serve.mjs"

const pinnedSource = readFileSync(join(root, "src/scan/assets.ts"), "utf8")
const pinnedPrefixes = [
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/wasm/",
  "https://storage.googleapis.com/mediapipe-models/",
]

export async function noRequestCarriesImageData() {
  const { browser, page, requests } = await openPage(`${root}/.cache/harness`)
  try {
    await page.evaluate(() => globalThis.harness.init("CPU", "full"))
    const beforeScan = requests.length
    const subject = manifest.subjects[1]
    const images = [fixture(subject.id, "face"), fixture(subject.id, "body")]
    await page.evaluate(([face, body]) => globalThis.harness.scan(face, body, 170, true), images)
    const duringScan = requests.slice(beforeScan).map((request) => request.url)
    assert.deepEqual(duringScan, [], "a scan makes no network request")
    for (const request of requests) {
      assert.equal(request.method, "GET", `${request.method} ${request.url}`)
      assert.equal(request.bytes, 0, `request body on ${request.url}`)
      const url = new URL(request.url)
      const file = url.pathname.split("/").at(-1) ?? ""
      const pinned = pinnedPrefixes.some((prefix) => request.url.startsWith(prefix)) && pinnedSource.includes(file)
      assert.ok(url.origin === origin || pinned, `unexpected request ${request.url}`)
      assert.ok(!/data:image|base64/i.test(request.url), `image data in ${request.url}`)
    }
  } finally {
    await browser.close()
  }
}
