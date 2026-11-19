// Validates GLB files with the Khronos glTF-Validator. Fails on any error; prints warnings; ignores infos and hints.
// Usage: node tooling/validate-glb.mjs <file.glb|directory>...
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { validateBytes } from "gltf-validator"

/** Validates one GLB. External resources are refused: the engine's GLBs are self-contained. */
export async function validateGlb(bytes, uri = "model.glb") {
  const report = await validateBytes(new Uint8Array(bytes), {
    uri,
    maxIssues: 200,
    externalResourceFunction: (name) => Promise.reject(new Error(`external resource ${String(name)} is not allowed`)),
  })
  const messages = report.issues.messages ?? []
  return {
    report,
    errors: messages.filter((message) => message.severity === 0),
    warnings: messages.filter((message) => message.severity === 1),
  }
}

function collect(paths) {
  return paths.flatMap((path) =>
    statSync(path).isDirectory()
      ? collect(readdirSync(path).map((name) => join(path, name)))
      : path.toLowerCase().endsWith(".glb")
        ? [path]
        : [],
  )
}

async function main() {
  const files = collect(process.argv.slice(2))
  if (files.length === 0) {
    console.error("No .glb files given.")
    process.exitCode = 1
    return
  }
  for (const file of files) {
    const { errors, warnings, report } = await validateGlb(readFileSync(file), file)
    const info = report.info ?? {}
    console.log(
      `${file}: ${String(errors.length)} errors, ${String(warnings.length)} warnings ` +
        `(${String(info.totalVertexCount ?? "?")} vertices, ${String(info.morphedPrimitivesCount ?? 0)} morphed, ${String(info.skinnedPrimitivesCount ?? 0)} skinned)`,
    )
    for (const issue of [...errors, ...warnings])
      console.log(
        `  ${issue.severity === 0 ? "error" : "warning"} ${issue.code} ${issue.pointer ?? ""}: ${issue.message}`,
      )
    if (errors.length > 0) process.exitCode = 1
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main()
