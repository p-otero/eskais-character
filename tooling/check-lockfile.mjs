// Fails when bun.lock is missing or out of step with package.json, when a pin is a range, or when node_modules holds
// a different version than the pin (a stale install would test code nobody ships).
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const root = join(import.meta.dirname, "..")
const exact = /^(?:\d+\.\d+\.\d+(?:-[\w.]+)?|github:[\w.-]+\/[\w.-]+#[0-9a-f]{40})$/

// bun.lock is JSON with trailing commas.
export function parseBunLock(text) {
  return JSON.parse(text.replaceAll(/,(\s*[}\]])/g, "$1"))
}

export function lockfileProblems(pkg, lock, installedVersion) {
  const problems = []
  const workspace = lock.workspaces?.[""] ?? {}
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const wanted = pkg[field] ?? {}
    const locked = workspace[field] ?? {}
    for (const [name, spec] of Object.entries(wanted)) {
      if (!exact.test(spec)) problems.push(`${name}@${spec}: not an exact pin`)
      if (locked[name] !== spec)
        problems.push(`${name}: package.json has ${spec}, bun.lock has ${String(locked[name])}`)
      const entry = lock.packages?.[name]?.[0]
      if (typeof entry !== "string") {
        problems.push(`${name}: not resolved in bun.lock`)
        continue
      }
      const resolved = entry.slice(entry.indexOf("@", 1) + 1)
      const github = spec.startsWith("github:")
      const expected = github ? spec.replace(/#([0-9a-f]{7})[0-9a-f]*$/, "#$1") : spec
      if (resolved !== expected) problems.push(`${name}: bun.lock resolves ${resolved}, package.json pins ${spec}`)
      const installed = installedVersion(name)
      if (installed !== undefined && !github && installed !== spec)
        problems.push(`${name}: node_modules has ${installed}, pinned ${spec}; run bun install --frozen-lockfile`)
    }
    for (const name of Object.keys(locked))
      if (!(name in wanted)) problems.push(`${name}: in bun.lock ${field} but not in package.json`)
  }
  return problems
}

function main() {
  const lockPath = join(root, "bun.lock")
  if (!existsSync(lockPath)) {
    console.error("bun.lock is missing: run bun install and commit it.")
    process.exitCode = 1
    return
  }
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  const lock = parseBunLock(readFileSync(lockPath, "utf8"))
  const installedVersion = (name) => {
    const file = join(root, "node_modules", name, "package.json")
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).version : undefined
  }
  const problems = lockfileProblems(pkg, lock, installedVersion)
  if (problems.length === 0) {
    console.log("bun.lock matches package.json, every pin is exact, and node_modules matches the pins.")
    return
  }
  for (const problem of problems) console.error(problem)
  process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main()
