// No real person's photo may enter the repo: every image must be a PNG from tooling/synth, listed with its SHA-256 in a
// generator manifest and tagged with its tEXt chunk; raster data URIs are refused. `--rerender` re-renders each subject
// and compares pixels, so a photo given a hand-written manifest entry still fails.
// Usage: bun tooling/check-images.ts [--rerender]
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import type { SynthManifest } from "./synth/generate.ts"
import { decodePng } from "./synth/png.ts"

const root = join(import.meta.dirname, "..")

export const imageExtension = /\.(png|jpe?g|webp|gif|bmp|avif|heic|heif|tiff?|ico|jxl)$/i
const textExtension = /\.(ts|tsx|mts|js|mjs|cjs|jsx|html|css|svg|md|json|yml|yaml)$/i
const dataUri = /data:image\/(png|jpe?g|webp|gif|avif|bmp|heic|heif|tiff?)[;,]/i
const generatorPrefix = "eskais-synth/"

/** Pixel tolerance of --rerender: a few rounding differences between JavaScript engines, never a different picture. */
export const rerenderTolerance = { maxChannelDiff: 2, minMatchingShare: 0.999 }

function workingTreeFiles(): string[] {
  const output = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
  return output.split("\0").filter((file) => file !== "" && existsSync(join(root, file)))
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

interface Listed {
  manifestPath: string
  manifest: SynthManifest
  kind: string
  subject: string
  sha256: string
}

export function readManifests(files: string[]): Map<string, Listed> {
  const listed = new Map<string, Listed>()
  for (const file of files) {
    if (!file.endsWith("manifest.json")) continue
    let manifest: SynthManifest
    try {
      manifest = JSON.parse(readFileSync(join(root, file), "utf8")) as SynthManifest
    } catch {
      continue
    }
    if (typeof manifest.generator !== "string" || !manifest.generator.startsWith(generatorPrefix)) continue
    for (const image of manifest.images) {
      const path = relative(root, join(root, dirname(file), image.file))
        .split("\\")
        .join("/")
      listed.set(path, { manifestPath: file, manifest, kind: image.kind, subject: image.subject, sha256: image.sha256 })
    }
  }
  return listed
}

export function checkImage(path: string, bytes: Uint8Array, entry: Listed | undefined): string[] {
  if (!entry) return [`${path}: not produced by the synthetic generator (no manifest lists it)`]
  const problems: string[] = []
  if (sha256(bytes) !== entry.sha256) problems.push(`${path}: SHA-256 differs from ${entry.manifestPath}`)
  if (!path.toLowerCase().endsWith(".png")) return [...problems, `${path}: the generator only writes PNG`]
  try {
    const { text } = decodePng(bytes)
    const tag = text["eskais-synthetic"]
    if (!tag) problems.push(`${path}: no eskais-synthetic tEXt chunk`)
    else {
      const parsed = JSON.parse(tag) as { subject?: string; kind?: string }
      if (parsed.subject !== entry.subject || parsed.kind !== entry.kind)
        problems.push(`${path}: its tEXt chunk names ${String(parsed.subject)}/${String(parsed.kind)}`)
    }
    if (!text["Software"]?.startsWith(generatorPrefix)) problems.push(`${path}: Software tEXt is not the generator`)
  } catch (error) {
    problems.push(`${path}: not a PNG the generator wrote (${(error as Error).message})`)
  }
  return problems
}

export function comparePixels(a: Uint8Array, b: Uint8Array): { share: number; maxDiff: number } {
  if (a.length !== b.length) return { share: 0, maxDiff: 255 }
  let matching = 0
  let maxDiff = 0
  for (let pixel = 0; pixel < a.length; pixel += 4) {
    let worst = 0
    for (let channel = 0; channel < 4; channel++)
      worst = Math.max(worst, Math.abs((a[pixel + channel] ?? 0) - (b[pixel + channel] ?? 0)))
    maxDiff = Math.max(maxDiff, worst)
    if (worst <= rerenderTolerance.maxChannelDiff) matching++
  }
  return { share: matching / (a.length / 4), maxDiff }
}

async function rerender(listed: Map<string, Listed>, problems: string[]): Promise<number> {
  const { loadAnny } = await import("../test/load-anny.ts")
  const { renderImage } = await import("./synth/render.ts")
  const model = loadAnny()
  const bySubject = new Map<string, { entry: Listed; paths: Map<string, string> }>()
  for (const [path, entry] of listed) {
    const key = `${entry.manifestPath}#${entry.subject}`
    const group = bySubject.get(key) ?? { entry, paths: new Map<string, string>() }
    group.paths.set(entry.kind, path)
    bySubject.set(key, group)
  }
  for (const { entry, paths } of bySubject.values()) {
    const subject = entry.manifest.subjects.find((candidate) => candidate.id === entry.subject)
    if (!subject) {
      problems.push(`${entry.manifestPath}: lists images of ${entry.subject} but not its parameters`)
      continue
    }
    for (const [kind, path] of paths) {
      if (!existsSync(join(root, path))) continue
      const decoded = decodePng(readFileSync(join(root, path)))
      const image = renderImage(model, subject, kind)
      const { share, maxDiff } = comparePixels(decoded.rgba, image.rgba)
      if (
        decoded.width !== image.width ||
        decoded.height !== image.height ||
        share < rerenderTolerance.minMatchingShare
      )
        problems.push(
          `${path}: re-rendering ${entry.subject} does not reproduce it (${(share * 100).toFixed(3)}% of pixels within ${String(rerenderTolerance.maxChannelDiff)}, worst ${String(maxDiff)})`,
        )
    }
  }
  return bySubject.size
}

async function main() {
  const files = workingTreeFiles()
  const listed = readManifests(files)
  const problems: string[] = []
  let images = 0
  for (const file of files) {
    if (imageExtension.test(file)) {
      images++
      problems.push(...checkImage(file, readFileSync(join(root, file)), listed.get(file)))
    } else if (textExtension.test(file) && !file.endsWith("bun.lock")) {
      const text = readFileSync(join(root, file), "utf8")
      if (dataUri.test(text)) problems.push(`${file}: embeds a raster image as a data URI`)
    }
  }
  for (const [path, entry] of listed)
    if (!existsSync(join(root, path))) problems.push(`${entry.manifestPath}: lists ${path}, which is missing`)
  let rerendered = 0
  if (process.argv.includes("--rerender") && problems.length === 0) rerendered = await rerender(listed, problems)
  if (problems.length === 0) {
    console.log(
      `${String(images)} images, all from the synthetic generator` +
        (process.argv.includes("--rerender") ? `; ${String(rerendered)} subjects re-rendered and matched.` : "."),
    )
    return
  }
  for (const problem of problems) console.error(problem)
  console.error('Only synthetic images from tooling/synth may be committed (AGENTS.md "Images").')
  process.exitCode = 1
}

if (import.meta.main) await main()
