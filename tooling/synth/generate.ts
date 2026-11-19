// Renders the synthetic set: `bun tooling/synth/generate.ts [--count=24] [--seed=1] [--out=.synth]`.
// Writes <id>-face.png, <id>-body.png and manifest.json (parameters, colours and the SHA-256 of every image).
import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { loadAnny } from "../../test/load-anny.ts"
import { encodePng } from "./png.ts"
import { renderSubject } from "./render.ts"
import { generatorVersion, makeSubjects, type Subject } from "./subjects.ts"

export interface ManifestImage {
  file: string
  kind: "face" | "body"
  subject: string
  sha256: string
}

export interface SynthManifest {
  generator: string
  seed: number
  count: number
  subjects: Subject[]
  images: ManifestImage[]
}

export function imageText(subject: Subject, kind: "face" | "body", seed: number): Record<string, string> {
  return { Software: generatorVersion, "eskais-synthetic": JSON.stringify({ seed, subject: subject.id, kind }) }
}

function argument(name: string, fallback: string): string {
  const found = process.argv.find((arg) => arg.startsWith(`--${name}=`))
  return found ? found.slice(name.length + 3) : fallback
}

if (import.meta.main) {
  const count = Number(argument("count", "24"))
  const seed = Number(argument("seed", "1"))
  const out = resolve(argument("out", ".synth"))
  mkdirSync(out, { recursive: true })
  const model = loadAnny()
  const subjects = makeSubjects(model, count, seed)
  const images: ManifestImage[] = []
  for (const subject of subjects) {
    const started = performance.now()
    const rendered = renderSubject(model, subject)
    for (const kind of ["face", "body"] as const) {
      const image = rendered[kind]
      const png = encodePng(image.width, image.height, image.rgba, imageText(subject, kind, seed))
      const file = `${subject.id}-${kind}.png`
      writeFileSync(join(out, file), png)
      images.push({ file, kind, subject: subject.id, sha256: createHash("sha256").update(png).digest("hex") })
    }
    console.log(`${subject.id} ${subject.hair} ${(performance.now() - started).toFixed(0)} ms`)
  }
  const manifest: SynthManifest = { generator: generatorVersion, seed, count, subjects, images }
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
}
