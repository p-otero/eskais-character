// Fails on any installed package or asset whose licence is not on the permissive allow-list, on any file under assets/
// that assets/ASSETS.json does not list, and on anything from the SMPL / Max Planck family (AGENTS.md "Licences").
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { pathToFileURL } from "node:url"

const root = join(import.meta.dirname, "..")

export const allowedLicences = new Set([
  "MIT",
  "MIT-0",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "CC0-1.0",
  "Unlicense",
  "BlueOak-1.0.0",
])

// Data only (never code), and only with the attribution recorded in LICENSES.md.
export const allowedDataLicences = new Set(["CC-BY-4.0"])

// Packages outside the allow-list, each with the reason it is acceptable. An exception must stay out of the
// production dependency closure: it may be a build tool, never something the engine ships.
export const licenceExceptions = {
  lightningcss:
    "MPL-2.0, a Vite build-time dependency (CSS transform for the demo). It runs at build time and none of its code ends up in the engine or the demo bundle.",
}

// A platform binary package ("lightningcss-linux-x64-gnu") shares its parent's exception.
function exceptionFor(name) {
  if (name in licenceExceptions) return name
  return Object.keys(licenceExceptions).find((parent) => name.startsWith(`${parent}-`))
}

// SMPL, SMPL-X, FLAME and models trained on SMPL or Max Planck data are forbidden (non-commercial licences).
export const forbiddenName = /smpl|flame|deca|emoca|\bmica\b|shapy|amass|star-body/i
export const forbiddenExceptions = {}

// "MIT", "(MIT OR Apache-2.0)", "Apache-2.0 AND CC0-1.0": every AND-term must be allowed; one OR-alternative suffices.
export function licenceAllowed(expression, allowed = allowedLicences) {
  const text = expression.trim().replace(/^\((.*)\)$/, "$1")
  if (/\sOR\s/.test(text)) return text.split(/\s+OR\s+/).some((part) => licenceAllowed(part, allowed))
  if (/\sAND\s/.test(text)) return text.split(/\s+AND\s+/).every((part) => licenceAllowed(part, allowed))
  return allowed.has(text.replace(/[()]/g, ""))
}

function licenceOf(pkg) {
  if (typeof pkg.license === "string") return pkg.license
  if (pkg.license?.type) return pkg.license.type
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((entry) => entry.type ?? entry).join(" OR ")
  return "UNKNOWN"
}

export function installedPackages(modules) {
  const found = new Map()
  const walk = (directory) => {
    if (!existsSync(directory)) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue
      const path = join(directory, entry.name)
      if (entry.name.startsWith("@")) {
        walk(path)
        continue
      }
      const manifest = join(path, "package.json")
      if (existsSync(manifest)) {
        const pkg = JSON.parse(readFileSync(manifest, "utf8"))
        if (pkg.name) found.set(`${pkg.name}@${pkg.version}`, { pkg, path })
      }
      walk(join(path, "node_modules"))
    }
  }
  walk(modules)
  return found
}

function productionClosure(rootPackage, packages) {
  const byName = new Map([...packages.values()].map(({ pkg }) => [pkg.name, pkg]))
  const seen = new Set()
  const visit = (name) => {
    if (seen.has(name)) return
    seen.add(name)
    const pkg = byName.get(name)
    for (const dependency of Object.keys({ ...pkg?.dependencies, ...pkg?.optionalDependencies })) visit(dependency)
  }
  for (const name of Object.keys(rootPackage.dependencies ?? {})) visit(name)
  return seen
}

function listFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    return statSync(path).isDirectory() ? listFiles(path) : [path]
  })
}

export function checkLicences() {
  const problems = []
  const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  if (!licenceAllowed(rootPackage.license)) problems.push(`package.json: licence ${rootPackage.license}`)
  const packages = installedPackages(join(root, "node_modules"))
  const production = productionClosure(rootPackage, packages)
  const usedExceptions = new Set()
  for (const [id, { pkg }] of packages) {
    const licence = licenceOf(pkg)
    if (forbiddenName.test(pkg.name) && !(pkg.name in forbiddenExceptions))
      problems.push(`${id}: forbidden name (SMPL / Max Planck family)`)
    if (licenceAllowed(licence)) continue
    const exception = exceptionFor(pkg.name)
    if (exception) {
      usedExceptions.add(exception)
      if (production.has(pkg.name)) problems.push(`${id}: ${licence} is an exception for build tools only, but ships`)
      continue
    }
    problems.push(`${id}: licence "${licence}" is not on the allow-list`)
  }

  const assetsPath = join(root, "assets", "ASSETS.json")
  const assets = JSON.parse(readFileSync(assetsPath, "utf8"))
  const listed = new Set()
  for (const entry of assets.local ?? []) {
    if (!licenceAllowed(entry.licence, new Set([...allowedLicences, ...allowedDataLicences])))
      problems.push(`${entry.files.join(", ")}: licence "${entry.licence}" is not allowed`)
    for (const file of entry.files) {
      listed.add(file)
      if (!existsSync(join(root, file))) problems.push(`${file}: listed in assets/ASSETS.json but missing`)
      if (forbiddenName.test(file)) problems.push(`${file}: forbidden name (SMPL / Max Planck family)`)
    }
    if (!entry.source || !entry.checked) problems.push(`${entry.files.join(", ")}: needs a source and a checked date`)
  }
  for (const entry of assets.remote ?? []) {
    if (!licenceAllowed(entry.licence, new Set([...allowedLicences, ...allowedDataLicences])))
      problems.push(`${entry.name}: licence "${entry.licence}" is not allowed`)
    if (!entry.url.startsWith("https://") || !/^[0-9a-f]{64}$/.test(entry.sha256) || !(entry.bytes > 0))
      problems.push(`${entry.name}: a remote asset needs an https URL, a SHA-256 and a size`)
    if (/\/latest\//.test(entry.url)) problems.push(`${entry.name}: pin a versioned URL, not /latest/`)
    if (forbiddenName.test(entry.name) || forbiddenName.test(entry.url))
      problems.push(`${entry.name}: forbidden name (SMPL / Max Planck family)`)
  }
  for (const file of listFiles(join(root, "assets"))) {
    const path = relative(root, file).split("\\").join("/")
    if (path === "assets/ASSETS.json") continue
    if (!listed.has(path)) problems.push(`${path}: not listed in assets/ASSETS.json`)
  }
  for (const name of Object.keys(licenceExceptions))
    if (!usedExceptions.has(name))
      problems.push(`${name}: listed in licenceExceptions but not installed; remove the exception`)
  return { problems, packageCount: packages.size, exceptions: [...usedExceptions] }
}

function main() {
  const { problems, packageCount, exceptions } = checkLicences()
  if (problems.length === 0) {
    console.log(
      `${String(packageCount)} packages and every asset have allowed licences` +
        (exceptions.length > 0 ? ` (build-time exceptions: ${exceptions.join(", ")}).` : "."),
    )
    return
  }
  for (const problem of problems) console.error(problem)
  console.error('See AGENTS.md "Licences".')
  process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main()
