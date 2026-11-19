// Capabilities: "auto" takes MediaPipe's GPU delegate on a hardware GPU and the CPU delegate on a software rasteriser;
// both delegates work on SwiftShader; without WebGL2 at all the engine refuses up front. WebGPU is reported only.
import assert from "node:assert/strict"
import { fixture, manifest } from "../fixtures.mjs"
import { openPage, root } from "../serve.mjs"

export async function withoutWebglTheEngineSaysSoUpFront() {
  // No GPU process and no software rasteriser: Chrome has no WebGL at all. MediaPipe Tasks needs WebGL2 even on its
  // CPU delegate, so the engine must reject `ready` with a capability error instead of failing mid-scan.
  const args = ["--disable-gpu", "--disable-software-rasterizer"]
  const { browser, page } = await openPage(`${root}/.cache/harness`, "index.html", { args })
  try {
    const webgl = await page.evaluate(() => !!new OffscreenCanvas(1, 1).getContext("webgl2"))
    assert.equal(webgl, false, "WebGL is disabled for this test")
    const outcome = await page.evaluate(() =>
      globalThis.harness.init("auto", "lite").then(
        () => "ready",
        (error) => `${error.name} ${error.code}: ${error.message}`,
      ),
    )
    assert.match(outcome, /^ScanError webgl2-unavailable: .*needs WebGL2/)
  } finally {
    await browser.close()
  }
}

export async function cpuDelegateScansOnSoftwareWebgl() {
  const { browser, page } = await openPage(`${root}/.cache/harness`)
  try {
    const ready = await page.evaluate(() => globalThis.harness.init("CPU", "lite"))
    assert.equal(ready.delegate, "CPU")
    const bytes = fixture(manifest.subjects[0].id, "face")
    const result = await page.evaluate((png) => globalThis.harness.detect("face", png), bytes)
    assert.equal(result.landmarks?.length, 478 * 3)
  } finally {
    await browser.close()
  }
}

export async function autoPrefersCpuOnSoftwareWebgl() {
  const { browser, page } = await openPage(`${root}/.cache/harness`)
  try {
    const ready = await page.evaluate(() => globalThis.harness.init("auto", "lite"))
    assert.equal(ready.delegate, "CPU", "SwiftShader is a software rasteriser, so auto keeps MediaPipe on the CPU")
  } finally {
    await browser.close()
  }
}

export async function gpuDelegateStartsOnSwiftShader() {
  const { browser, page } = await openPage(`${root}/.cache/harness`)
  try {
    const capabilities = await page.evaluate(() => ({
      webgl2: !!new OffscreenCanvas(1, 1).getContext("webgl2"),
      webgpu: "gpu" in navigator,
    }))
    assert.ok(capabilities.webgl2, "SwiftShader provides WebGL2")
    const ready = await page.evaluate(() => globalThis.harness.init("GPU", "lite"))
    assert.equal(ready.delegate, "GPU")
    console.log(`    WebGPU exposed: ${String(capabilities.webgpu)}`)
  } finally {
    await browser.close()
  }
}
