// Builds the stylised character from fitted parameters: stylised proportions, the outfit, painted regions, eyes and
// hair, with the style's colour treatment. The GLB writer serialises it; the repo's software renderer draws it.

import { evaluateShape, type AnnyModel } from "./anny.ts"
import { eyeballs } from "./eyes.ts"
import { buildHair, type HairStyle } from "./hair.ts"
import { computeNormals, srgbToLinear, type Rgb } from "./color-space.ts"
import { dressBody, outfitPalettes, type GarmentId, type OutfitId } from "./outfit.ts"
import { headFrame, meshParts, paintRegions, Region } from "./regions.ts"
import { styleColor, stylePresets, type StylePreset } from "./style.ts"
import { applyToPoints, headScaler, stylizeFace } from "./stylize.ts"

export interface CharacterColors {
  skin: Rgb
  eyes: Rgb
  hair: Rgb
  brows: Rgb
  lips?: Rgb
  beard: Rgb | null
}

/** The fitted look with no stylisation and no outfit: what the scan's maths sees. */
export const neutralLook: CharacterLook = { style: stylePresets["soft-toon"], stylize: 0, outfit: "none" }

export interface CharacterLook {
  style: StylePreset
  /** 0 keeps the fitted proportions, 1 is the strongest stylisation. */
  stylize: number
  outfit: OutfitId
}

export interface CharacterInput {
  model: AnnyModel
  body: ArrayLike<number>
  face: ArrayLike<number>
  colors: CharacterColors
  hair: HairStyle
  /** Defaults to `neutralLook`. */
  look?: CharacterLook
  /** Lighter eyes for compact files. */
  compact?: boolean
  /** "base": the mean body, for live morphing while a scan runs; "character": the fitted body. */
  mode: "base" | "character"
}

export interface CharacterMesh {
  name: "body" | "eyes" | "hair"
  positions: Float32Array
  normals: Float32Array
  /** Linear RGB per vertex, style treatment applied. */
  colors: Float32Array
  indices: Uint16Array | Uint32Array
  /** Bone index per vertex for single-joint meshes (eyes); the body uses Anny's skin. */
  joint?: Uint8Array
  /** Four joints and normalized byte weights per vertex (hair: blended from the skin of the vertices it hangs from). */
  skin?: { joints: Uint8Array; weights: Uint8Array }
}

export interface Character {
  meshes: CharacterMesh[]
  /** Joint heads after stylisation, bone order. */
  bones: Float32Array
  /** Face modifier values the morph weights carry (fitted plus the stylised offsets). */
  face: Float32Array
  /**
   * What the GLB stores as the body's POSITION: the mean shape plus the part of the final shape morph targets can't
   * express (head scale, garments), so mean + Σ weights × targets lands on the final body.
   */
  bodyBase: Float32Array
}

const mouthInside: [number, number, number] = [0.08, 0.015, 0.015]

/**
 * Skin for hair: each hair vertex takes the blended skin of the three body vertices it hangs from, so long hair
 * follows the neck and back in clips instead of moving rigidly with the head.
 */
function anchoredSkin(
  model: AnnyModel,
  anchors: Uint32Array,
  anchorWeights: Float32Array,
): { joints: Uint8Array; weights: Uint8Array } {
  const count = anchors.length / 3
  const joints = new Uint8Array(count * 4)
  const weights = new Uint8Array(count * 4)
  for (let v = 0; v < count; v++) {
    const total = new Map<number, number>()
    for (let corner = 0; corner < 3; corner++) {
      const vertex = anchors[v * 3 + corner] ?? 0
      const w = anchorWeights[v * 3 + corner] ?? 0
      for (let slot = 0; slot < 4; slot++) {
        const joint = model.skinJoints[vertex * 4 + slot] ?? 0
        const share = ((model.skinWeights[vertex * 4 + slot] ?? 0) / 255) * w
        if (share > 0) total.set(joint, (total.get(joint) ?? 0) + share)
      }
    }
    const top = [...total.entries()].toSorted((a, b) => b[1] - a[1]).slice(0, 4)
    const sum = top.reduce((acc, [, w]) => acc + w, 0) || 1
    const bytes = top.map(([, w]) => Math.round((w / sum) * 255))
    // glTF wants the normalized weights to sum to exactly 255.
    if (bytes.length > 0) bytes[0] = (bytes[0] ?? 0) + 255 - bytes.reduce((acc, b) => acc + b, 0)
    top.forEach(([joint], slot) => {
      // A slot whose weight rounds to 0 points at joint 0, as glTF recommends.
      joints[v * 4 + slot] = (bytes[slot] ?? 0) > 0 ? joint : 0
      weights[v * 4 + slot] = bytes[slot] ?? 0
    })
  }
  return { joints, weights }
}

/**
 * Toon faces read clean when their shading follows a simple head shape, not every nose and cheek bump: face normals
 * blend towards an ellipsoid around the head, fading out down the neck. The GLB carries these normals too.
 */
function toonFaceNormals(
  model: AnnyModel,
  vertices: Float32Array,
  normals: Float32Array,
  bones: Float32Array,
  amount: number,
): Float32Array {
  const bone = (name: string) => {
    const index = model.boneLabels.indexOf(name)
    return [bones[index * 3] ?? 0, bones[index * 3 + 1] ?? 0, bones[index * 3 + 2] ?? 0]
  }
  const head = bone("head")
  const neck = bone("neck02")
  const eyeL = bone("eye.L")
  const eyeR = bone("eye.R")
  const eyeY = ((eyeL[1] ?? 0) + (eyeR[1] ?? 0)) / 2
  const halfWidth = Math.abs((eyeL[0] ?? 0) - (eyeR[0] ?? 0)) * 1.25
  const centre = [head[0] ?? 0, eyeY, (head[2] ?? 0) + 0.005]
  const radii = [halfWidth, halfWidth * 1.35, halfWidth * 1.15]
  const blend = 0.75 + 0.25 * amount
  const out = new Float32Array(normals)
  for (let v = 0; v < model.vertexCount; v++) {
    const y = vertices[v * 3 + 1] ?? 0
    const fade = Math.min(Math.max((y - (neck[1] ?? 0)) / ((head[1] ?? 0) - (neck[1] ?? 0) + 0.04), 0), 1)
    if (fade <= 0) continue
    const e = [0, 1, 2].map((axis) => ((vertices[v * 3 + axis] ?? 0) - (centre[axis] ?? 0)) / (radii[axis] ?? 1) ** 2)
    const length = Math.hypot(e[0] ?? 0, e[1] ?? 0, e[2] ?? 0) || 1
    const w = blend * fade
    const n = [0, 1, 2].map((axis) => (normals[v * 3 + axis] ?? 0) * (1 - w) + ((e[axis] ?? 0) / length) * w)
    const nl = Math.hypot(n[0] ?? 0, n[1] ?? 0, n[2] ?? 0) || 1
    for (let axis = 0; axis < 3; axis++) out[v * 3 + axis] = (n[axis] ?? 0) / nl
  }
  return out
}

export function buildCharacter(input: CharacterInput): Character {
  const { model, colors, hair, mode } = input
  const look = input.look ?? neutralLook
  const character = mode === "character"
  const face = character
    ? stylizeFace(model, input.face, look.stylize)
    : new Float32Array(model.faceModifierLabels.length)
  const body = character ? input.body : new Float32Array(model.bodyRank)
  const morphed = evaluateShape(model, { body, face })
  const scale = headScaler(model, morphed.bones, look.stylize)
  const scaled = applyToPoints(morphed.vertices, scale)
  const bones = applyToPoints(morphed.bones, scale)
  const parts = meshParts(model, scaled)
  const scaledNormals = computeNormals(scaled, model.faces)
  const frame = headFrame(model, bones, scaled, parts)
  const regions = paintRegions(model, scaled, scaledNormals, frame, parts)
  const dressed = dressBody(model, scaled, scaledNormals, bones, look.outfit)
  const normals = toonFaceNormals(
    model,
    dressed.vertices,
    computeNormals(dressed.vertices, model.faces),
    bones,
    look.stylize,
  )

  const treat = (color: ArrayLike<number>) => styleColor(look.style, color)
  const skin = srgbToLinear(colors.skin)
  // Softer lips than the photo-like renders: per-vertex colour blurs a strong lip edge on this mesh.
  const lips = colors.lips ? srgbToLinear(colors.lips) : (skin.map((c, k) => c * ([0.9, 0.7, 0.7][k] ?? 1)) as Rgb)
  const palette: Record<number, readonly number[]> = {
    [Region.skin]: skin,
    [Region.lips]: lips,
    [Region.brows]: srgbToLinear(colors.brows),
    [Region.scalp]: hair.length === "none" ? skin : srgbToLinear(colors.hair),
    [Region.beard]: colors.beard ? srgbToLinear(colors.beard) : skin,
    [Region.eyeball]: skin,
    [Region.mouthInside]: mouthInside,
  }
  const garments = look.outfit === "none" ? null : outfitPalettes[look.outfit]
  const garmentColor = (id: GarmentId) => (garments ? srgbToLinear(garments[id]) : skin)
  const bodyColors = new Float32Array(model.vertexCount * 3)
  for (let v = 0; v < model.vertexCount; v++) {
    const id = dressed.garment[v]
    bodyColors.set(treat(id ? garmentColor(id) : (palette[regions[v] ?? 0] ?? skin)), v * 3)
  }

  // Anny's low-poly eyeballs (parts 2 and 3) are replaced by the eyes mesh. Their vertices stay, unreferenced, so the
  // vertex order matches the model and every morph target lines up with it.
  const bodyIndices: number[] = []
  for (let t = 0; t < model.faces.length; t += 3)
    if ((parts[model.faces[t] ?? 0] ?? 0) < 2)
      bodyIndices.push(model.faces[t] ?? 0, model.faces[t + 1] ?? 0, model.faces[t + 2] ?? 0)

  const meshes: CharacterMesh[] = [
    { name: "body", positions: dressed.vertices, normals, colors: bodyColors, indices: new Uint16Array(bodyIndices) },
  ]

  const eyes = eyeballs(frame, srgbToLinear(colors.eyes), { stylized: true, ...(input.compact ? { detail: 3 } : {}) })
  const eyeColors = new Float32Array(eyes.colors.length)
  for (let v = 0; v < eyeColors.length; v += 3) eyeColors.set(treat(eyes.colors.subarray(v, v + 3)), v)
  const eyeLeft = model.boneLabels.indexOf("eye.L")
  const eyeRight = model.boneLabels.indexOf("eye.R")
  const eyeCount = eyes.positions.length / 3
  meshes.push({
    name: "eyes",
    positions: eyes.positions,
    normals: computeNormals(eyes.positions, eyes.indices),
    colors: eyeColors,
    indices: eyes.indices,
    joint: Uint8Array.from({ length: eyeCount }, (_, v) => (v < eyeCount / 2 ? eyeLeft : eyeRight)),
  })

  const hairMesh = buildHair(hair, dressed.vertices, normals, model.faces, regions, frame)
  if (hairMesh.indices.length > 0) {
    const count = hairMesh.positions.length / 3
    const base = treat(srgbToLinear(colors.hair))
    const hairColors = new Float32Array(count * 3)
    const shade = (hairMesh as { shade?: Float32Array }).shade
    for (let v = 0; v < count; v++) {
      const factor = shade ? 0.82 + 0.18 * (shade[v] ?? 1) : 1
      hairColors.set(
        base.map((channel) => channel * factor),
        v * 3,
      )
    }
    meshes.push({
      name: "hair",
      positions: hairMesh.positions,
      normals: (hairMesh as { normals?: Float32Array }).normals ?? computeNormals(hairMesh.positions, hairMesh.indices),
      colors: hairColors,
      indices: hairMesh.indices,
      ...(hairMesh.anchors && hairMesh.anchorWeights
        ? { skin: anchoredSkin(model, hairMesh.anchors, hairMesh.anchorWeights) }
        : { joint: new Uint8Array(count).fill(model.boneLabels.indexOf("head")) }),
    })
  }

  const bodyBase = new Float32Array(model.meanVertices)
  for (let index = 0; index < bodyBase.length; index++)
    bodyBase[index] = (bodyBase[index] ?? 0) + (dressed.vertices[index] ?? 0) - (morphed.vertices[index] ?? 0)
  return { meshes, bones, face, bodyBase }
}
