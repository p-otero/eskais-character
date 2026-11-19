// Serves a built page to Playwright from disk and stands in for the pinned asset hosts with the local cache, so tests
// run offline. Every request is recorded; anything not served from these maps is aborted.
import { readFileSync, existsSync } from "node:fs"
import { extname, join } from "node:path"
import { chromium } from "playwright"

export const root = join(import.meta.dirname, "..", "..")
export const origin = "https://app.test"

const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".bin": "application/octet-stream",
  ".task": "application/octet-stream",
  ".glb": "model/gltf-binary",
}

const remote = {
  "cdn.jsdelivr.net": (path) => {
    const match = path.match(/^\/npm\/@mediapipe\/tasks-vision@1\.2\.3\/wasm\/(.+)$/)
    return match && join(root, "node_modules/@mediapipe/tasks-vision/wasm", match[1])
  },
  "storage.googleapis.com": (path) => {
    const match = path.match(/^\/mediapipe-models\/.+\/float16\/1\/([a-z_]+\.task)$/)
    return match && join(root, ".cache/models", match[1])
  },
}

/**
 * Launches Chrome (system Chrome when present, else Playwright's Chromium) and opens `page` from `dir`.
 * Options: gpu (use the GPU; default SwiftShader), device (Playwright device descriptor), cpuThrottle.
 */
export async function openPage(dir, page = "index.html", options = {}) {
  const args =
    options.args ??
    (options.gpu
      ? ["--enable-gpu", "--ignore-gpu-blocklist", "--enable-unsafe-webgpu"]
      : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--enable-unsafe-webgpu"])
  let browser
  try {
    browser = await chromium.launch({ channel: "chrome", headless: options.headless ?? true, args })
  } catch {
    browser = await chromium.launch({ headless: options.headless ?? true, args })
  }
  const context = await browser.newContext(options.device ?? {})
  const tab = await context.newPage()
  const requests = []
  tab.on("console", (message) => {
    if (message.type() === "error") console.error(`[page] ${message.text().slice(0, 300)}`)
  })
  tab.on("pageerror", (error) => console.error(`[page error] ${error.message}`))
  await context.route("**/*", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    requests.push({
      method: request.method(),
      url: request.url(),
      bytes: request.postDataBuffer()?.length ?? 0,
      headers: request.headers(),
    })
    let file
    if (url.origin === origin) file = join(dir, decodeURIComponent(url.pathname === "/" ? page : url.pathname))
    else if (remote[url.host]) file = remote[url.host](url.pathname)
    if (!file || !existsSync(file)) return route.abort("blockedbyclient")
    const headers = {
      "content-type": types[extname(file)] ?? "application/octet-stream",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp",
      "cross-origin-resource-policy": "cross-origin",
      "access-control-allow-origin": "*",
    }
    return route.fulfill({ body: readFileSync(file), headers })
  })
  if (options.cpuThrottle) {
    const cdp = await context.newCDPSession(tab)
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: options.cpuThrottle })
  }
  await tab.goto(`${origin}/${page}`)
  return { browser, context, page: tab, requests }
}
