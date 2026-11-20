// Your own photo through the engine on this machine (README "Try it on your own photo"); never enters the repo.
// Offline: every request outside the local files is aborted. The photo stays in memory and is never written.
// Usage: bun run scan:photo -- --face me.jpg [--body body.jpg] [--height 175] [--stylize 0.5]
// Output (GLB and renders per style, fitted parameters) goes to the git-ignored .local/scans/<time>/.
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { extname, join, resolve } from "node:path"
import { buildHarness } from "../browser/build-harness.mjs"
import { openPage, root } from "../browser/serve.mjs"

const arg = (name: string) => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}
const facePath = arg("face")
if (!facePath) {
  console.error("Usage: bun run scan:photo -- --face <photo> [--body <photo>] [--height <cm>] [--stylize 0..1]")
  process.exit(2)
}
const outRoot = join(root, ".local")
// Refuse to write anywhere git would pick up.
const ignored = (() => {
  try {
    execFileSync("git", ["check-ignore", "-q", join(outRoot, "probe")], { cwd: root })
    return true
  } catch {
    return false
  }
})()
if (!ignored) {
  console.error(".local/ is not ignored by git; refusing to write output there.")
  process.exit(1)
}
for (const model of ["face_landmarker.task", "pose_landmarker_full.task"])
  if (!existsSync(join(root, ".cache/models", model))) {
    console.error(`Missing .cache/models/${model}: run \`bun run fetch:models\` once first.`)
    process.exit(1)
  }

const types: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
}
const readPhoto = (path: string) => {
  const type = types[extname(path).toLowerCase()]
  if (!type) throw new Error(`${path}: use a JPEG, PNG or WebP photo.`)
  return { bytes: Array.from(readFileSync(resolve(path))), type }
}
const face = readPhoto(facePath)
const bodyPath = arg("body")
const body = bodyPath ? readPhoto(bodyPath) : null
const height = arg("height")
const stylize = Number(arg("stylize") ?? "0.5")

await buildHarness()
const { browser, page, requests } = await openPage(join(root, ".cache/harness"))
try {
  await page.evaluate(() =>
    (globalThis as never as { harness: { init(a: string, b: string): Promise<unknown> } }).harness.init("auto", "full"),
  )
  const result = (await page.evaluate(
    ([faceInput, bodyInput, cm, amount]) =>
      (globalThis as never as { harness: { scanPhotos(...args: unknown[]): Promise<unknown> } }).harness.scanPhotos(
        faceInput,
        bodyInput,
        cm,
        amount,
      ),
    [face, body, height ? Number(height) : null, stylize] as const,
  )) as {
    error?: { code: string; message: string }
    params?: unknown
    colors?: unknown
    hair?: string
    styles?: { style: string; glb: string; front: string; side: string }[]
    timings?: unknown
  }
  if (result.error) throw new Error(`${result.error.code}: ${result.error.message}`)
  const out = join(outRoot, "scans", new Date().toISOString().replace(/[:.]/g, "-"))
  mkdirSync(out, { recursive: true })
  for (const style of result.styles ?? []) {
    writeFileSync(join(out, `character-${style.style}.glb`), Buffer.from(style.glb, "base64"))
    writeFileSync(join(out, `${style.style}-front.png`), Buffer.from(style.front.split(",")[1] ?? "", "base64"))
    writeFileSync(join(out, `${style.style}-side.png`), Buffer.from(style.side.split(",")[1] ?? "", "base64"))
  }
  writeFileSync(
    join(out, "character.json"),
    JSON.stringify(
      { params: result.params, colors: result.colors, hair: result.hair, timings: result.timings },
      null,
      2,
    ) + "\n",
  )
  const external = requests.filter(
    (request) =>
      !request.url.startsWith("https://app.test/") &&
      !request.url.includes("cdn.jsdelivr.net/npm/@mediapipe") &&
      !request.url.includes("storage.googleapis.com/mediapipe-models"),
  )
  console.log(`Done. Output in ${out}`)
  console.log(
    `Requests: ${String(requests.length)}, all served from local files; ${String(external.length)} other requests were blocked.`,
  )
} finally {
  await browser.close()
}
