// Installs the packed package into fresh Vite, Next.js (Turbopack and webpack) and bun apps (tooling/package/consumers/*), builds each, and
// runs a full scan and a restyle in Chrome: the worker and model files must resolve through each bundler.
// Usage: bun tooling/package/consumers.ts [--only=vite,next,next-webpack,bun] [--keep]
// The apps install from the npm registry: vite, next and react at the exact versions below, at least 7 days old.
import { spawn, spawnSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium } from "playwright"
import { openPage, root } from "../browser/serve.mjs"

const versions = { vite: "8.3.8", next: "16.4.6", react: "19.3.1", typescript: "5.9.3", reactTypes: "19.3.0" }
const only = (process.argv.find((arg) => arg.startsWith("--only="))?.slice(7) ?? "vite,next,next-webpack,bun").split(
  ",",
)
const work = mkdtempSync(join(tmpdir(), "eskais-consumers-"))
const templates = join(import.meta.dirname, "consumers")
const npm = process.platform === "win32" ? "npm.cmd" : "npm"
const npx = process.platform === "win32" ? "npx.cmd" : "npx"

function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", shell: process.platform === "win32" })
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed in ${cwd}:\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}

run(npm, ["pack", "--pack-destination", work], root)
const tarball = readdirSync(work).find((file) => file.endsWith(".tgz"))
if (!tarball) throw new Error("npm pack wrote no tarball.")

function app(name: string, manifest: Record<string, unknown>) {
  const dir = join(work, name)
  cpSync(join(templates, name), dir, { recursive: true })
  mkdirSync(join(dir, "public"), { recursive: true })
  for (const kind of ["face", "body"])
    cpSync(join(root, `fixtures/synthetic/s001-${kind}.png`), join(dir, "public", `s001-${kind}.png`))
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: `consumer-${name}`, private: true, ...manifest }, null, 2),
  )
  run(npm, ["install", "--no-audit", "--no-fund"], dir)
  return dir
}

const dependency = { "eskais-character": `file:../${tarball}` }
const results: Record<string, string> = {}

async function resultIn(page: import("playwright").Page, browser: import("playwright").Browser) {
  try {
    return await waitForResult(page)
  } finally {
    await browser.close()
  }
}

async function waitForResult(page: import("playwright").Page) {
  await page.waitForFunction(() => /^(DONE|FAIL)/.test(document.getElementById("out")?.textContent ?? ""), null, {
    timeout: 180_000,
  })
  return (await page.textContent("#out")) ?? ""
}

if (only.includes("vite")) {
  const dir = app("vite", { type: "module", dependencies: dependency, devDependencies: { vite: versions.vite } })
  run(npx, ["vite", "build"], dir)
  const { browser, page } = await openPage(join(dir, "dist"), "index.html")
  results["vite (production build)"] = await resultIn(page, browser)
}

if (only.includes("bun")) {
  const dir = app("bun", { type: "module", dependencies: dependency })
  run("bun", ["build", "./index.html", "--outdir", "out", "--minify"], dir)
  // bun doesn't emit `new URL(…, import.meta.url)` targets: the worker is copied by hand (workerUrl), the model files
  // come from the package's pinned CDN copy, which serve.mjs answers from this checkout.
  cpSync(join(dir, "node_modules/eskais-character/dist/worker.js"), join(dir, "out/worker.js"))
  for (const file of readdirSync(join(dir, "public"))) cpSync(join(dir, "public", file), join(dir, "out", file))
  const { browser, page } = await openPage(join(dir, "out"), "index.html")
  results["bun build (workerUrl + CDN assets)"] = await resultIn(page, browser)
}

async function runNext(name: string, label: string, buildArgs: string[]) {
  const dir = app(name, {
    dependencies: { ...dependency, next: versions.next, react: versions.react, "react-dom": versions.react },
    devDependencies: { typescript: versions.typescript, "@types/react": versions.reactTypes },
  })
  run(npx, ["next", "build", ...buildArgs], dir)
  const port = 3100 + Math.floor(Math.random() * 500)
  // Next started through node directly, so killing the child stops the server (npx on Windows would leave it).
  const server = spawn(
    process.execPath.endsWith("bun.exe") || process.execPath.endsWith("bun") ? "node" : process.execPath,
    [join(dir, "node_modules/next/dist/bin/next"), "start", "-p", String(port)],
    { cwd: dir },
  )
  try {
    for (let attempt = 0; attempt < 60; attempt++) {
      const ok = await fetch(`http://localhost:${String(port)}/`).then(
        (response) => response.ok,
        () => false,
      )
      if (ok) break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    const browser = await chromium
      .launch({ channel: "chrome", args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] })
      .catch(() => chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] }))
    const page = await browser.newPage()
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url())
      const file = url.pathname.split("/").at(-1) ?? ""
      if (url.host === "cdn.jsdelivr.net")
        return route.fulfill({
          body: readFileSync(join(root, "node_modules/@mediapipe/tasks-vision/wasm", file)),
          headers: {
            "access-control-allow-origin": "*",
            "content-type": file.endsWith(".wasm") ? "application/wasm" : "text/javascript",
          },
        })
      if (url.host === "storage.googleapis.com")
        return route.fulfill({
          body: readFileSync(join(root, ".cache/models", file)),
          headers: { "access-control-allow-origin": "*" },
        })
      return url.hostname === "localhost" ? route.continue() : route.abort()
    })
    await page.goto(`http://localhost:${String(port)}/`)
    results[label] = await resultIn(page, browser)
  } finally {
    if (process.platform === "win32" && server.pid) spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"])
    else server.kill()
  }
}

if (only.includes("next")) await runNext("next", "next (Turbopack production build)", [])
if (only.includes("next-webpack")) await runNext("next-webpack", "next (webpack production build)", ["--webpack"])

let failed = false
for (const [name, result] of Object.entries(results)) {
  console.log(`${result.startsWith("DONE") ? "ok  " : "FAIL"} ${name}: ${result}`)
  if (!result.startsWith("DONE")) failed = true
}
if (!process.argv.includes("--keep"))
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
  } catch {
    // Windows can hold a file of the stopped Next server for a moment; the temp folder is cleaned by the OS later.
    console.log(`Could not remove ${work} yet.`)
  }
else console.log(`Apps kept in ${work}`)
if (failed) process.exitCode = 1
