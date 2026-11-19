// Fails when a dependency in package.json is not an exact pin or was published less than 7 days ago: a young release
// has had no time for the ecosystem to catch a compromised or broken publish. A `github:` dependency must name a full
// commit. Usage: node tooling/check-dependency-age.mjs [--require-network]. Offline it skips, unless --require-network.
// Adapted from eskais-ui's tooling/check-dependency-age.mjs.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

export const minimumAgeDays = 7
const day = 24 * 60 * 60 * 1000

// Pins allowed to be younger, each with its reason. One stays allowed only at this exact version: a bump has to be
// added here again on purpose. Once it is old enough the check says so, and the entry should go.
export const youngDependencyExceptions = {}

const exactVersion = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/
const githubCommit = /^github:[\w.-]+\/[\w.-]+#[0-9a-f]{40}$/
const notOnNpm = /^(?:github:|git\+|git:|https?:|file:|link:|workspace:)/

export function packageDependencies(pkg) {
  return Object.entries({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies })
    .map(([name, version]) => `${name}@${String(version)}`)
    .toSorted()
}

export function parseDependency(spec) {
  const at = spec.indexOf("@", 1)
  return { name: spec.slice(0, at), version: spec.slice(at + 1) }
}

// `published` maps each "name@version" to its ISO publish time. Returns the pins that fail and the exceptions that are
// old enough to remove.
export function findYoungDependencies(
  specs,
  published,
  now,
  { minimumDays = minimumAgeDays, exceptions = youngDependencyExceptions } = {},
) {
  const problems = []
  const matured = []
  for (const spec of Object.keys(exceptions))
    if (!specs.includes(spec)) problems.push({ spec, reason: "is an exception but package.json no longer has it" })
  for (const spec of specs) {
    const { name, version } = parseDependency(spec)
    if (notOnNpm.test(version)) {
      if (!githubCommit.test(version))
        problems.push({ spec, reason: "a non-npm dependency must be `github:owner/repo#<40-hex commit>`" })
      continue
    }
    if (!exactVersion.test(version)) {
      problems.push({ spec, reason: "not pinned to an exact version" })
      continue
    }
    const time = published.get(`${name}@${version}`)
    if (time === undefined) {
      problems.push({ spec, reason: "not found on the npm registry" })
      continue
    }
    const age = (now - Date.parse(time)) / day
    const young = age < minimumDays
    if (young && !(spec in exceptions))
      problems.push({
        spec,
        reason: `published ${time.slice(0, 10)}, ${age.toFixed(1)} days ago (minimum ${String(minimumDays)})`,
      })
    if (!young && spec in exceptions) matured.push(spec)
  }
  return { problems, matured }
}

class OfflineError extends Error {}

async function fetchPublishTimes(specs) {
  const names = new Set()
  for (const spec of specs) {
    const { name, version } = parseDependency(spec)
    if (!notOnNpm.test(version)) names.add(name)
  }
  const published = new Map()
  await Promise.all(
    [...names].map(async (name) => {
      let response
      try {
        response = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}`, {
          signal: AbortSignal.timeout(20_000),
        })
      } catch (error) {
        throw new OfflineError(`${name}: ${error.cause?.code ?? error.message}`)
      }
      if (response.status === 404) return
      if (!response.ok) throw new Error(`${name}: the npm registry answered ${String(response.status)}`)
      const { time = {} } = await response.json()
      for (const [version, at] of Object.entries(time)) published.set(`${name}@${version}`, at)
    }),
  )
  return published
}

async function main() {
  const requireNetwork = process.argv.includes("--require-network")
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"))
  const specs = packageDependencies(pkg)
  let published
  try {
    published = await fetchPublishTimes(specs)
  } catch (error) {
    if (!(error instanceof OfflineError)) throw error
    const message = `registry.npmjs.org is unreachable (${error.message})`
    if (requireNetwork) {
      console.error(`The dependency age check failed: ${message}, and --require-network is set.`)
      process.exitCode = 1
    } else console.log(`Skipped the dependency age check: ${message}.`)
    return
  }
  const { problems, matured } = findYoungDependencies(specs, published, Date.now())
  for (const spec of matured)
    console.log(`${spec} is ${String(minimumAgeDays)} days old now: remove it from youngDependencyExceptions.`)
  if (problems.length === 0) {
    const allowed = Object.keys(youngDependencyExceptions).length - matured.length
    console.log(
      `The ${String(specs.length)} dependencies are exact pins at least ${String(minimumAgeDays)} days old` +
        (allowed > 0 ? `, apart from ${String(allowed)} listed exceptions.` : "."),
    )
    return
  }
  for (const { spec, reason } of problems) console.error(`${spec}: ${reason}`)
  console.error(`Pin a release at least ${String(minimumAgeDays)} days old (AGENTS.md "Dependencies").`)
  process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main()
