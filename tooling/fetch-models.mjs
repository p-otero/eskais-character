// Downloads the pinned remote model files listed in assets/ASSETS.json into .cache/models, checking size and SHA-256.
// Browser tests and benchmarks serve them from there, so they never touch the network.
// Usage: node tooling/fetch-models.mjs
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dirname, "..")
const directory = join(root, ".cache", "models")
const { remote } = JSON.parse(readFileSync(join(root, "assets", "ASSETS.json"), "utf8"))

function verify(bytes, entry) {
  const hash = createHash("sha256").update(bytes).digest("hex")
  if (bytes.length !== entry.bytes) return `is ${String(bytes.length)} bytes, expected ${String(entry.bytes)}`
  if (hash !== entry.sha256) return `has SHA-256 ${hash}, expected ${entry.sha256}`
  return undefined
}

mkdirSync(directory, { recursive: true })
let failed = false
// Files that ship in an npm package (the MediaPipe WASM) come from node_modules, not from here.
for (const entry of remote.filter((item) => !item.package)) {
  const path = join(directory, entry.name)
  if (existsSync(path) && verify(readFileSync(path), entry) === undefined) {
    console.log(`${entry.name}: cached`)
    continue
  }
  const response = await fetch(entry.url, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) {
    console.error(`${entry.name}: ${entry.url} answered ${String(response.status)}`)
    failed = true
    continue
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  const problem = verify(bytes, entry)
  if (problem) {
    console.error(`${entry.name}: the download ${problem}`)
    failed = true
    continue
  }
  writeFileSync(path, bytes)
  console.log(`${entry.name}: downloaded, ${String(bytes.length)} bytes, SHA-256 verified`)
}
if (failed) process.exitCode = 1
