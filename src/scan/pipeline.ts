// The scan, inside the worker: detect, sample colours, fit body then face, pick hair, export. Streams events as it
// goes; the photo's pixels are read once into memory for colour sampling and dropped with the bitmap.

import manifest from "../../assets/anny/anny.json" with { type: "json" }
import bodyCalibration from "../../assets/anny/body-calibration.json" with { type: "json" }
import bodyPriorData from "../../assets/anny/body-prior.json" with { type: "json" }
import facePriorData from "../../assets/anny/face-prior.json" with { type: "json" }
import faceMap from "../../assets/anny/face-landmarks.json" with { type: "json" }
import {
  bodyCoefficients,
  neutralPhenotype,
  parseAnny,
  type AnnyManifest,
  type AnnyModel,
  type Phenotype,
} from "../model/anny.ts"
import { morphTargetNames, morphWeights, writeCharacterGlb, type CharacterColors } from "../model/glb.ts"
import { hairStyle } from "../model/hair.ts"
import { stylePresets } from "../model/style.ts"
import { stylizeFace } from "../model/stylize.ts"
import { exportCharacter } from "./export.ts"
import { resolveLook } from "./look.ts"
import { hex, sampleFaceColors, type FaceColors, type Rgb } from "./colors.ts"
import type { Detectors } from "./detect.ts"
import { ScanError } from "./errors.ts"
import { createBodyFeatureModel, fitBody, type BodyCalibration } from "./fit-body.ts"
import { fitFace, type FaceLandmarkMap } from "./fit-face.ts"
import { pickHair } from "./hair-pick.ts"
import { fetchPinned, type AssetUrls } from "./loader.ts"
import { bodyFeatureNames, measureBody } from "./measure-body.ts"
import { alignedFaceShape, predictLinear, type FacePrior, type LinearPrior } from "./priors.ts"
import type { ScanRequest } from "./protocol.ts"
import type { ScanEvent, ScanStage } from "./types.ts"

export interface ScanContext {
  emit(event: ScanEvent, transfer?: Transferable[]): void
  cancelled(): boolean
}

export class ScanCancelled extends Error {
  override name = "ScanCancelled"
}

let modelPromise: Promise<AnnyModel> | undefined

export function loadModel(urls: AssetUrls, signal?: AbortSignal): Promise<AnnyModel> {
  modelPromise ??= fetchPinned("annyModel", urls, signal).then((buffer) => parseAnny(buffer, manifest as AnnyManifest))
  return modelPromise
}

function readPixels(image: ImageBitmap) {
  const canvas = new OffscreenCanvas(image.width, image.height)
  const context = canvas.getContext("2d", { willReadFrequently: true })
  if (!context) throw new Error("No 2D canvas in this worker.")
  context.drawImage(image, 0, 0)
  const pixels = context.getImageData(0, 0, image.width, image.height)
  // Shrink the canvas so its backing store with the photo is released now, not at GC.
  canvas.width = 1
  canvas.height = 1
  return pixels
}

function points2d(landmarks: Float32Array, stride: number): Float32Array {
  const count = landmarks.length / stride
  const out = new Float32Array(count * 2)
  for (let index = 0; index < count; index++) {
    out[index * 2] = landmarks[index * stride] ?? 0
    out[index * 2 + 1] = landmarks[index * stride + 1] ?? 0
  }
  return out
}

/** Toon-friendly defaults when a colour couldn't be read. */
function characterColors(colors: FaceColors): CharacterColors {
  const hair: Rgb = colors.hair ?? colors.brows
  return { skin: colors.skin, eyes: colors.eyes, brows: colors.brows, hair, beard: colors.beard }
}

export async function runScan(
  detectors: Detectors,
  request: ScanRequest,
  context: ScanContext,
  urls: AssetUrls = {},
): Promise<void> {
  const model = await loadModel(urls)
  const timings: Partial<Record<ScanStage, number>> = {}
  let stageStart = 0
  let currentStage: ScanStage | undefined
  const stage = (next: ScanStage | null) => {
    if (currentStage) {
      const ms = performance.now() - stageStart
      timings[currentStage] = ms
      context.emit({ type: "stage", stage: currentStage, ms })
    }
    if (context.cancelled()) throw new ScanCancelled("The scan was cancelled.")
    currentStage = next ?? undefined
    stageStart = performance.now()
    if (next) context.emit({ type: "stage", stage: next })
  }
  const warnings: string[] = []
  const look = resolveLook(request.look)

  stage("detect-face")
  const face = detectors.detectFace(request.face)
  if (!face) throw new ScanError("no-face", "No face found in the face photo.")
  const faceLandmarks = points2d(face.landmarks, 3)
  context.emit({ type: "landmarks", source: "face", points: faceLandmarks, aspect: face.width / face.height }, [
    faceLandmarks.buffer,
  ])

  stage("colors")
  const sampled = sampleFaceColors(readPixels(request.face), face.landmarks)
  request.face.close()
  const colors = characterColors(sampled)

  let measured: ReturnType<typeof measureBody> = null
  if (request.body) {
    stage("detect-body")
    const body = detectors.detectBody(request.body)
    request.body.close()
    if (!body) warnings.push("No body found in the body photo; the body keeps average proportions.")
    else {
      const bodyLandmarks = points2d(body.landmarks, 4)
      context.emit({ type: "landmarks", source: "body", points: bodyLandmarks, aspect: body.width / body.height }, [
        bodyLandmarks.buffer,
      ])
      measured = body.mask ? measureBody(body.landmarks, body.mask, body.width, body.height) : null
      if (!measured) warnings.push("The body outline was not found; the body keeps average proportions.")
    }
  }

  stage("export")
  const targetNames = morphTargetNames(model)
  const base = writeCharacterGlb({
    model,
    body: bodyCoefficients(model, neutralPhenotype),
    face: new Float32Array(model.faceModifierLabels.length),
    colors,
    hair: hairStyle("none"),
    look: { style: stylePresets[look.style], stylize: look.stylize, outfit: look.outfit },
    mode: "base",
  })
  context.emit({ type: "model", glb: base.glb, targetNames }, [base.glb.buffer])

  let phenotype: Phenotype = neutralPhenotype
  // Progress weights carry the look's face offsets, so the live morph already shows the stylised face.
  const emptyFace = stylizeFace(model, new Float32Array(model.faceModifierLabels.length), look.stylize)
  const stature = request.hints.heightCm ? request.hints.heightCm / 100 : undefined
  let bodyQuality: number | null = null
  if (measured) {
    stage("fit-body")
    const bodyPrior = bodyPriorData as LinearPrior
    const features = measured.features
    const prior = {
      mean: predictLinear(
        bodyPrior,
        bodyFeatureNames.map((name) => features[name]),
      ),
      sigma: bodyPrior.residualSigma,
    }
    const fit = fitBody(
      model,
      bodyCalibration as BodyCalibration,
      measured.features,
      {
        prior,
        ...(stature === undefined ? {} : { stature }),
        onIteration: (current, iteration, iterations) => {
          const weights = morphWeights(model, bodyCoefficients(model, current), emptyFace)
          context.emit({ type: "progress", value: (0.6 * (iteration + 1)) / iterations, weights }, [weights.buffer])
        },
      },
      createBodyFeatureModel(model),
    )
    phenotype = fit.phenotype
    bodyQuality = Math.max(0, Math.min(1, measured.confidence * Math.exp(-Math.max(fit.residual - 1, 0) / 2)))
  }
  const body = bodyCoefficients(model, phenotype)

  stage("fit-face")
  const facePrior = facePriorData as FacePrior
  const priorFace = predictLinear(
    facePrior,
    alignedFaceShape(face.landmarks, face.width, face.height, facePrior.landmarks, facePrior.meanShape),
  )
  const faceFit = fitFace(model, faceMap as FaceLandmarkMap, body, face, {
    prior: priorFace,
    // Only modifiers the landmarks predict on held-out synthetic people (R² ≥ 0.15) move; the rest stay at the prior.
    free: model.faceModifierLabels.map((_, index) => (facePrior.r2?.[index] ?? 0) >= 0.15),
    lambda: 2e-5,
    onIteration: (current, iteration, iterations) => {
      const weights = morphWeights(model, body, stylizeFace(model, current, look.stylize))
      context.emit({ type: "progress", value: 0.6 + (0.35 * (iteration + 1)) / iterations, weights }, [weights.buffer])
    },
  })
  if (faceFit.rmsMm > 4) warnings.push("The face fit is loose; a frontal, evenly lit face photo works best.")

  stage("hair")
  const style = hairStyle(pickHair(sampled))

  stage("export")
  const character = exportCharacter(model, {
    params: {
      phenotype,
      face: Object.fromEntries(model.faceModifierLabels.map((label, index) => [label, faceFit.face[index] ?? 0])),
    },
    colors: {
      skin: hex(colors.skin),
      eyes: hex(colors.eyes),
      hair: hex(colors.hair),
      brows: hex(colors.brows),
      beard: colors.beard ? hex(colors.beard) : null,
    },
    hairId: style.id,
    look,
    quality: { face: Math.max(0, Math.min(1, 1 - faceFit.rmsMm / 8)), body: bodyQuality, warnings },
  })
  stage(null)
  context.emit({ type: "progress", value: 1, weights: character.weights.slice() })
  context.emit({ type: "done", character }, [character.glb.buffer])
}
