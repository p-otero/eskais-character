// Body measurements from a front photo, as ratios to the stature in pixels: segment lengths from the pose landmarks
// and silhouette widths from the person mask. The same features are computed on the model (modelBodyFeatures), so the
// fit compares like with like. Only these numbers leave this module; the mask stays in the worker.

import type { AnnyModel } from "../model/anny.ts"
import type { PersonMask } from "./detect.ts"

export const bodyFeatureNames = [
  "shoulderWidth",
  "hipWidth",
  "upperArm",
  "forearm",
  "thigh",
  "shin",
  "torso",
  "neckToNose",
  "chestWidth",
  "waistWidth",
  "hipSilhouette",
  "thighWidth",
  "calfWidth",
  "neckWidth",
] as const
export type BodyFeatureName = (typeof bodyFeatureNames)[number]
export type BodyFeatures = Record<BodyFeatureName, number>

/** MediaPipe Pose landmark indices. */
const P = {
  nose: 0,
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
} as const

type Point = [number, number]

function distance(a: Point, b: Point): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}

function mid(a: Point, b: Point): Point {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
}

function lerp(a: Point, b: Point, t: number): Point {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

/** Shared by the photo and the model: lengths from joint points, widths from a width-at-height function. */
function features(
  joint: (index: number) => Point,
  stature: number,
  widthAt: (point: Point, part: "torso" | "leftLeg" | "rightLeg" | "neck") => number,
): BodyFeatures {
  const shoulders = mid(joint(P.leftShoulder), joint(P.rightShoulder))
  const hips = mid(joint(P.leftHip), joint(P.rightHip))
  const both = (a: number, b: number, c: number, d: number) =>
    (distance(joint(a), joint(b)) + distance(joint(c), joint(d))) / 2
  const thighWidth =
    (widthAt(lerp(joint(P.leftHip), joint(P.leftKnee), 0.3), "leftLeg") +
      widthAt(lerp(joint(P.rightHip), joint(P.rightKnee), 0.3), "rightLeg")) /
    2
  const calfWidth =
    (widthAt(lerp(joint(P.leftKnee), joint(P.leftAnkle), 0.3), "leftLeg") +
      widthAt(lerp(joint(P.rightKnee), joint(P.rightAnkle), 0.3), "rightLeg")) /
    2
  return {
    shoulderWidth: distance(joint(P.leftShoulder), joint(P.rightShoulder)) / stature,
    hipWidth: distance(joint(P.leftHip), joint(P.rightHip)) / stature,
    upperArm: both(P.leftShoulder, P.leftElbow, P.rightShoulder, P.rightElbow) / stature,
    forearm: both(P.leftElbow, P.leftWrist, P.rightElbow, P.rightWrist) / stature,
    thigh: both(P.leftHip, P.leftKnee, P.rightHip, P.rightKnee) / stature,
    shin: both(P.leftKnee, P.leftAnkle, P.rightKnee, P.rightAnkle) / stature,
    torso: distance(shoulders, hips) / stature,
    neckToNose: Math.abs(joint(P.nose)[1] - shoulders[1]) / stature,
    chestWidth: widthAt(lerp(shoulders, hips, 0.25), "torso") / stature,
    waistWidth: widthAt(lerp(shoulders, hips, 0.62), "torso") / stature,
    hipSilhouette: widthAt(lerp(shoulders, hips, 1.05), "torso") / stature,
    thighWidth: thighWidth / stature,
    calfWidth: calfWidth / stature,
    neckWidth: widthAt(lerp(shoulders, joint(P.nose), 0.35), "neck") / stature,
  }
}

/** Width of the mask run through `point`, in pixels; 0 when the point is outside the person. */
function maskWidth(mask: PersonMask, point: Point): number {
  const y = Math.round(point[1])
  const x = Math.round(point[0])
  if (y < 0 || y >= mask.height || x < 0 || x >= mask.width) return 0
  const row = y * mask.width
  const inside = (column: number) => (mask.data[row + column] ?? 0) >= 128
  if (!inside(x)) return 0
  let left = x
  let right = x
  while (left > 0 && inside(left - 1)) left--
  while (right < mask.width - 1 && inside(right + 1)) right++
  // Sub-pixel edges from the soft mask values either side.
  const edge = (column: number) => (mask.data[row + column] ?? 0) / 255
  return right - left + 1 + edge(left - 1) + edge(right + 1)
}

export interface MeasuredBody {
  features: BodyFeatures
  /** Mean landmark visibility of the joints used. */
  confidence: number
}

export function measureBody(
  landmarks: ArrayLike<number>,
  mask: PersonMask,
  width: number,
  height: number,
): MeasuredBody | null {
  // Mask and landmarks share the image's pixel grid (MediaPipe returns the mask at the input size).
  const sx = mask.width / width
  const sy = mask.height / height
  const joint = (index: number): Point => [
    (landmarks[index * 4] ?? 0) * width * sx,
    (landmarks[index * 4 + 1] ?? 0) * height * sy,
  ]
  let top = -1
  let bottom = -1
  for (let y = 0; y < mask.height && top < 0; y++)
    for (let x = 0; x < mask.width; x++)
      if ((mask.data[y * mask.width + x] ?? 0) >= 128) {
        top = y
        break
      }
  for (let y = mask.height - 1; y >= 0 && bottom < 0; y--)
    for (let x = 0; x < mask.width; x++)
      if ((mask.data[y * mask.width + x] ?? 0) >= 128) {
        bottom = y
        break
      }
  if (top < 0 || bottom <= top) return null
  const stature = bottom - top + 1
  const used: number[] = Object.values(P)
  const confidence = used.reduce((sum, index) => sum + (landmarks[index * 4 + 3] ?? 0), 0) / used.length
  return { features: features(joint, stature, (point) => maskWidth(mask, point)), confidence }
}

const armBones = /^(clavicle|shoulder01|upperarm|lowerarm|wrist|finger|metacarpal)/
const legBones = /^(upperleg|lowerleg|foot|toe)/
const neckBones = /^(neck|head)/

export interface ModelFeatureContext {
  /** Per vertex: 0 torso, 1 arm, 2 left leg, 3 right leg, 4 neck/head. */
  part: Uint8Array
  joints: Record<
    | "shoulderL"
    | "shoulderR"
    | "elbowL"
    | "elbowR"
    | "wristL"
    | "wristR"
    | "hipL"
    | "hipR"
    | "kneeL"
    | "kneeR"
    | "ankleL"
    | "ankleR"
    | "head",
    number
  >
  noseVertex: number
}

export function modelFeatureContext(model: AnnyModel, vertices: Float32Array): ModelFeatureContext {
  const part = new Uint8Array(model.vertexCount)
  for (let v = 0; v < model.vertexCount; v++) {
    const label = model.boneLabels[model.skinJoints[v * 4] ?? 0] ?? ""
    if (armBones.test(label)) part[v] = 1
    else if (legBones.test(label)) part[v] = label.endsWith(".L") ? 2 : 3
    else if (neckBones.test(label)) part[v] = 4
  }
  let noseVertex = 0
  for (let v = 0; v < model.vertexCount; v++)
    if ((vertices[v * 3 + 2] ?? 0) > (vertices[noseVertex * 3 + 2] ?? 0) && part[v] === 4) noseVertex = v
  const bone = (name: string) => {
    const index = model.boneLabels.indexOf(name)
    if (index < 0) throw new Error(`No bone "${name}".`)
    return index
  }
  // Anny's .L side is the character's left, which faces the camera on the image's right, like MediaPipe's "left".
  return {
    part,
    noseVertex,
    joints: {
      shoulderL: bone("upperarm01.L"),
      shoulderR: bone("upperarm01.R"),
      elbowL: bone("lowerarm01.L"),
      elbowR: bone("lowerarm01.R"),
      wristL: bone("wrist.L"),
      wristR: bone("wrist.R"),
      hipL: bone("upperleg01.L"),
      hipR: bone("upperleg01.R"),
      kneeL: bone("lowerleg01.L"),
      kneeR: bone("lowerleg01.R"),
      ankleL: bone("foot.L"),
      ankleR: bone("foot.R"),
      head: bone("head"),
    },
  }
}

/** The same features on a rest-pose model, seen from the front (orthographic, image y down). */
export function modelBodyFeatures(
  context: ModelFeatureContext,
  vertices: Float32Array,
  bones: Float32Array,
): BodyFeatures {
  const bonePoint = (index: number): Point => [bones[index * 3] ?? 0, -(bones[index * 3 + 1] ?? 0)]
  const j = context.joints
  const byLandmark: Record<number, Point> = {
    [P.nose]: [vertices[context.noseVertex * 3] ?? 0, -(vertices[context.noseVertex * 3 + 1] ?? 0)],
    [P.leftShoulder]: bonePoint(j.shoulderL),
    [P.rightShoulder]: bonePoint(j.shoulderR),
    [P.leftElbow]: bonePoint(j.elbowL),
    [P.rightElbow]: bonePoint(j.elbowR),
    [P.leftWrist]: bonePoint(j.wristL),
    [P.rightWrist]: bonePoint(j.wristR),
    [P.leftHip]: bonePoint(j.hipL),
    [P.rightHip]: bonePoint(j.hipR),
    [P.leftKnee]: bonePoint(j.kneeL),
    [P.rightKnee]: bonePoint(j.kneeR),
    [P.leftAnkle]: bonePoint(j.ankleL),
    [P.rightAnkle]: bonePoint(j.ankleR),
  }
  let top = Number.NEGATIVE_INFINITY
  let bottom = Number.POSITIVE_INFINITY
  for (let v = 1; v < vertices.length; v += 3) {
    top = Math.max(top, vertices[v] ?? 0)
    bottom = Math.min(bottom, vertices[v] ?? 0)
  }
  const partCode = { torso: 0, leftLeg: 2, rightLeg: 3, neck: 4 } as const
  const widthAt = (point: Point, part: keyof typeof partCode) => {
    const y = -point[1]
    const code = partCode[part]
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    // A band 1 cm high; legs and torso blend at the hips, so the torso band admits leg vertices too.
    for (let v = 0; v < context.part.length; v++) {
      const p = context.part[v]
      if (p !== code && !(code === 0 && (p === 2 || p === 3))) continue
      if (Math.abs((vertices[v * 3 + 1] ?? 0) - y) > 0.005) continue
      const x = vertices[v * 3] ?? 0
      min = Math.min(min, x)
      max = Math.max(max, x)
    }
    return max > min ? max - min : 0
  }
  return features((index) => byLandmark[index] ?? [0, 0], top - bottom, widthAt)
}
