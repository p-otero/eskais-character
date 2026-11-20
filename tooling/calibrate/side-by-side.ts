// Visual side-by-side for the report: held-out synthetic people (left) next to the character the scan fitted (right),
// rendered by the repo's generator, so the image guard can re-render and verify them.
// Runs the same fitting code as the worker on cached detections. Usage: bun tooling/calibrate/side-by-side.ts [--count=4]
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import bodyCalibration from "../../assets/anny/body-calibration.json" with { type: "json" }
import bodyPriorData from "../../assets/anny/body-prior.json" with { type: "json" }
import facePriorData from "../../assets/anny/face-prior.json" with { type: "json" }
import faceMap from "../../assets/anny/face-landmarks.json" with { type: "json" }
import { bodyCoefficients, type Phenotype } from "../../src/model/anny.ts"
import { sampleFaceColors } from "../../src/scan/colors.ts"
import { createBodyFeatureModel, fitBody, type BodyCalibration } from "../../src/scan/fit-body.ts"
import { fitFace, type FaceLandmarkMap } from "../../src/scan/fit-face.ts"
import { pickHair } from "../../src/scan/hair-pick.ts"
import { bodyFeatureNames, type BodyFeatures } from "../../src/scan/measure-body.ts"
import { alignedFaceShape, predictLinear, type FacePrior, type LinearPrior } from "../../src/scan/priors.ts"
import { loadAnny } from "../../test/load-anny.ts"
import { imageText, type ManifestImage, type SynthManifest } from "../synth/generate.ts"
import { decodePng, encodePng } from "../synth/png.ts"
import { renderComparison, renderImage } from "../synth/render.ts"
import { styleIds } from "../../src/model/style.ts"
import { generatorVersion, type Subject } from "../synth/subjects.ts"

const count = Number(process.argv.find((a) => a.startsWith("--count="))?.slice(8) ?? "4")
// How many subjects also get the per-style turntables and portraits (the report shows two).
const styleSubjects = 2
let styled = 0
const dir = ".cache/detections/seed-1"
const out = "docs/images"
const model = loadAnny()
const featureModel = createBodyFeatureModel(model)
const facePrior = facePriorData as FacePrior
const bodyPrior = bodyPriorData as LinearPrior
mkdirSync(out, { recursive: true })
const subjects: (Subject & { fitted: Subject })[] = []
const images: ManifestImage[] = []
for (const file of readdirSync(dir)
  .filter((name) => name.endsWith(".json"))
  .slice(0, count)) {
  const data = JSON.parse(readFileSync(join(dir, file), "utf8")) as {
    subject: Subject
    face: { landmarks: number[]; blendshapes: Record<string, number> }
    body: { features: BodyFeatures }
    faceSize: [number, number]
  }
  const features = data.body.features
  const prior = {
    mean: predictLinear(
      bodyPrior,
      bodyFeatureNames.map((name) => features[name]),
    ),
    sigma: bodyPrior.residualSigma,
  }
  const phenotype: Phenotype = fitBody(
    model,
    bodyCalibration as BodyCalibration,
    features,
    { prior },
    featureModel,
  ).phenotype
  const body = bodyCoefficients(model, phenotype)
  const [width, height] = data.faceSize
  const observation = { landmarks: data.face.landmarks, blendshapes: data.face.blendshapes, width, height }
  const faceFit = fitFace(model, faceMap as FaceLandmarkMap, body, observation, {
    prior: predictLinear(
      facePrior,
      alignedFaceShape(data.face.landmarks, width, height, facePrior.landmarks, facePrior.meanShape),
    ),
    free: model.faceModifierLabels.map((_, index) => (facePrior.r2?.[index] ?? 0) >= 0.15),
    lambda: 2e-5,
  })
  const png = decodePng(readFileSync(join(dir, file.replace(".json", "-face.png"))))
  const colors = sampleFaceColors({ width: png.width, height: png.height, data: png.rgba }, data.face.landmarks)
  const fitted: Subject = {
    ...data.subject,
    id: `${data.subject.id}-fit`,
    phenotype,
    face: Object.fromEntries(
      model.faceModifierLabels.map((label, index) => [label, Math.round(faceFit.face[index]! * 1e4) / 1e4]),
    ),
    colors: {
      skin: colors.skin,
      eyes: colors.eyes,
      hair: colors.hair ?? colors.brows,
      brows: colors.brows,
      beard: colors.beard,
    },
    hair: pickHair(colors),
  }
  const subject = { ...data.subject, fitted }
  subjects.push(subject)
  const rendered = renderComparison(model, data.subject, fitted)
  for (const kind of ["face", "body"] as const) {
    const image = rendered[kind]
    const bytes = encodePng(image.width, image.height, image.rgba, imageText(data.subject, kind, 1))
    const name = `${data.subject.id}-${kind}.png`
    writeFileSync(join(out, name), bytes)
    images.push({
      file: name,
      kind,
      subject: data.subject.id,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })
  }
  if (styled < styleSubjects) {
    styled++
    // The fitted character in every style: a turntable strip and a portrait, under its own subject entry.
    const character = { ...fitted, look: { stylize: 0.5, outfit: "casual" as const } }
    subjects.push(character as never)
    for (const style of styleIds)
      for (const what of ["turntable", "portrait"] as const) {
        const kind = `${what}:${style}`
        const image = renderImage(model, character, kind)
        const bytes = encodePng(image.width, image.height, image.rgba, imageText(character, kind, 1))
        const name = `${fitted.id}-${what}-${style}.png`
        writeFileSync(join(out, name), bytes)
        images.push({
          file: name,
          kind,
          subject: character.id,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        })
      }
  }
  console.log(`${data.subject.id}: hair ${data.subject.hair} → ${fitted.hair}`)
}
const manifest: SynthManifest & { note: string } = {
  generator: generatorVersion,
  note: "Truth (left) and fitted character (right) for held-out synthetic people; tooling/calibrate/side-by-side.ts.",
  seed: 1,
  count: subjects.length,
  subjects,
  images,
}
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
