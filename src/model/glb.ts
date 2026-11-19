// The character as GLB. Morph targets move vertices, not joints: "base" has the mean-shape skeleton for live morphing,
// "character" the fitted one. Deltas are normalized SHORT (KHR_mesh_quantization, ~0.03 mm steps, half the float32
// size); head-only targets are sparse.

import { evaluateShape, faceModifierWeights, type AnnyModel } from "./anny.ts"
import {
  ARRAY_BUFFER,
  FLOAT,
  GlbBuilder,
  UNSIGNED_BYTE,
  colorBytes,
  denseTarget,
  packGlb,
  singleJointSkin,
  sparseTarget,
  type Json,
} from "./glb-builder.ts"
import { eyeballs } from "./eyes.ts"
import { buildHair, type HairStyle } from "./hair.ts"
import { headFrame, meshParts, paintRegions, Region } from "./regions.ts"

/** sRGB, 0..255 per channel. */
export type Rgb = [number, number, number]

export interface CharacterColors {
  skin: Rgb
  eyes: Rgb
  hair: Rgb
  brows: Rgb
  lips?: Rgb
  beard: Rgb | null
}

export interface CharacterGlbInput {
  model: AnnyModel
  /** Body PCA coefficients: the weights of the body targets. */
  body: ArrayLike<number>
  /** Face modifier values in [-1, 1]: a positive value drives the "incr" target, a negative one the "decr" target. */
  face: ArrayLike<number>
  colors: CharacterColors
  hair: HairStyle
  mode: "base" | "character"
}

export interface CharacterGlb {
  glb: Uint8Array
  targetNames: string[]
  weights: Float32Array
}

export function morphTargetNames(model: AnnyModel): string[] {
  const names: string[] = []
  for (let k = 0; k < model.bodyRank; k++) names.push(`body.pc${String(k).padStart(2, "0")}`)
  for (const label of model.faceModifierLabels) names.push(`face.${label}.incr`, `face.${label}.decr`)
  for (const label of model.facialActionLabels) names.push(`expr.${label}`)
  return names
}

export function morphWeights(
  model: AnnyModel,
  body: ArrayLike<number>,
  face: ArrayLike<number>,
  expression?: ArrayLike<number>,
): Float32Array {
  const faceCount = model.faceModifierLabels.length
  const weights = new Float32Array(model.bodyRank + 2 * faceCount + model.facialActionLabels.length)
  for (let k = 0; k < model.bodyRank; k++) weights[k] = body[k] ?? 0
  const values = Array.from({ length: faceCount }, (_, index) => face[index] ?? 0)
  weights.set(faceModifierWeights(values), model.bodyRank)
  if (expression)
    for (let index = 0; index < model.facialActionLabels.length; index++)
      weights[model.bodyRank + 2 * faceCount + index] = expression[index] ?? 0
  return weights
}

export function srgbToLinear(color: Rgb): [number, number, number] {
  return color.map((channel) => {
    const c = Math.min(Math.max(channel, 0), 255) / 255
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }) as [number, number, number]
}

/** Area-weighted smooth normals over every triangle; a vertex no triangle uses gets +Z, so it stays unit length. */
export function computeNormals(positions: ArrayLike<number>, indices: ArrayLike<number>): Float32Array {
  const normals = new Float32Array(positions.length)
  for (let t = 0; t < indices.length; t += 3) {
    const a = (indices[t] ?? 0) * 3
    const b = (indices[t + 1] ?? 0) * 3
    const c = (indices[t + 2] ?? 0) * 3
    const abx = (positions[b] ?? 0) - (positions[a] ?? 0)
    const aby = (positions[b + 1] ?? 0) - (positions[a + 1] ?? 0)
    const abz = (positions[b + 2] ?? 0) - (positions[a + 2] ?? 0)
    const acx = (positions[c] ?? 0) - (positions[a] ?? 0)
    const acy = (positions[c + 1] ?? 0) - (positions[a + 1] ?? 0)
    const acz = (positions[c + 2] ?? 0) - (positions[a + 2] ?? 0)
    const nx = aby * acz - abz * acy
    const ny = abz * acx - abx * acz
    const nz = abx * acy - aby * acx
    for (const v of [a, b, c]) {
      normals[v] = (normals[v] ?? 0) + nx
      normals[v + 1] = (normals[v + 1] ?? 0) + ny
      normals[v + 2] = (normals[v + 2] ?? 0) + nz
    }
  }
  for (let v = 0; v < normals.length; v += 3) {
    const x = normals[v] ?? 0
    const y = normals[v + 1] ?? 0
    const z = normals[v + 2] ?? 0
    const length = Math.hypot(x, y, z)
    if (length < 1e-12) {
      normals[v] = 0
      normals[v + 1] = 0
      normals[v + 2] = 1
    } else {
      normals[v] = x / length
      normals[v + 1] = y / length
      normals[v + 2] = z / length
    }
  }
  return normals
}

export function writeCharacterGlb(input: CharacterGlbInput): CharacterGlb {
  const { model, colors, hair, mode } = input
  const vertexCount = model.vertexCount
  const targetNames = morphTargetNames(model)
  const fitted = morphWeights(model, input.body, input.face)
  const weights = mode === "character" ? fitted : new Float32Array(targetNames.length)
  const shape =
    mode === "character"
      ? evaluateShape(model, { body: input.body, face: input.face })
      : evaluateShape(model, { body: new Float32Array(model.bodyRank) })

  const parts = meshParts(model, shape.vertices)
  const normals = computeNormals(shape.vertices, model.faces)
  const frame = headFrame(model, shape.bones, shape.vertices, parts)
  const regions = paintRegions(model, shape.vertices, normals, frame, parts)

  const skin = srgbToLinear(colors.skin)
  const lips = colors.lips ? srgbToLinear(colors.lips) : (skin.map((c, k) => c * ([0.78, 0.5, 0.52][k] ?? 1)) as Rgb)
  const scalp = hair.length === "none" ? skin : srgbToLinear(colors.hair)
  const palette: Record<number, [number, number, number]> = {
    [Region.skin]: skin,
    [Region.lips]: lips,
    [Region.brows]: srgbToLinear(colors.brows),
    [Region.scalp]: scalp,
    [Region.beard]: colors.beard ? srgbToLinear(colors.beard) : skin,
    [Region.eyeball]: skin,
    [Region.mouthInside]: [0.08, 0.015, 0.015],
  }
  const vertexColors = new Float32Array(vertexCount * 3)
  for (let v = 0; v < vertexCount; v++) vertexColors.set(palette[regions[v] ?? 0] ?? skin, v * 3)

  // Anny's low-poly eyeballs (parts 2 and 3) are replaced by the eyes mesh. Their vertices stay, unreferenced, so the
  // vertex order matches the model and every morph target lines up with it.
  const bodyIndices: number[] = []
  for (let t = 0; t < model.faces.length; t += 3)
    if ((parts[model.faces[t] ?? 0] ?? 0) < 2)
      bodyIndices.push(model.faces[t] ?? 0, model.faces[t + 1] ?? 0, model.faces[t + 2] ?? 0)

  // Anny keeps four influences per vertex; a slot whose weight rounded to 0 points at joint 0, as glTF recommends.
  const bodyJoints = Uint8Array.from(model.skinJoints, (joint, slot) =>
    (model.skinWeights[slot] ?? 0) > 0 ? joint : 0,
  )
  const builder = new GlbBuilder()
  const bodyAttributes: Json = {
    POSITION: builder.vec3(new Float32Array(model.meanVertices), ARRAY_BUFFER),
    NORMAL: builder.vec3(normals, ARRAY_BUFFER),
    COLOR_0: builder.accessor({
      bufferView: builder.view(colorBytes(vertexColors, vertexCount), ARRAY_BUFFER),
      componentType: UNSIGNED_BYTE,
      normalized: true,
      count: vertexCount,
      type: "VEC4",
    }),
    JOINTS_0: builder.accessor({
      bufferView: builder.view(bodyJoints, ARRAY_BUFFER),
      componentType: UNSIGNED_BYTE,
      count: vertexCount,
      type: "VEC4",
    }),
    WEIGHTS_0: builder.accessor({
      bufferView: builder.view(model.skinWeights, ARRAY_BUFFER),
      componentType: UNSIGNED_BYTE,
      normalized: true,
      count: vertexCount,
      type: "VEC4",
    }),
  }
  const targets: Json[] = []
  for (let k = 0; k < model.bodyRank; k++)
    targets.push({ POSITION: denseTarget(builder, model.bodyBasisVertices, k * vertexCount * 3, vertexCount) })
  const subset = model.headSubset
  const subsetIndicesView = builder.view(new Uint16Array(subset))
  const subsetStride = subset.length * 3
  for (let target = 0; target < model.faceModifierLabels.length * 2; target++)
    targets.push({
      POSITION: sparseTarget(
        builder,
        model.faceModifiers,
        target * subsetStride,
        subset.length,
        vertexCount,
        subsetIndicesView,
      ),
    })
  for (let target = 0; target < model.facialActionLabels.length; target++)
    targets.push({
      POSITION: sparseTarget(
        builder,
        model.facialActions,
        target * subsetStride,
        subset.length,
        vertexCount,
        subsetIndicesView,
      ),
    })

  const meshes: Json[] = [
    {
      name: "body",
      primitives: [{ attributes: bodyAttributes, indices: builder.indices(bodyIndices), material: 0, targets }],
      weights: Array.from(weights),
      extras: { targetNames },
    },
  ]

  const eyeLeft = model.boneLabels.indexOf("eye.L")
  const eyeRight = model.boneLabels.indexOf("eye.R")
  const head = model.boneLabels.indexOf("head")
  const eyes = eyeballs(frame, srgbToLinear(colors.eyes))
  const eyeVertexCount = eyes.positions.length / 3
  const eyeJoints = new Uint8Array(eyeVertexCount)
  for (let v = 0; v < eyeVertexCount; v++) eyeJoints[v] = v < eyeVertexCount / 2 ? eyeLeft : eyeRight
  meshes.push({
    name: "eyes",
    primitives: [
      {
        attributes: {
          POSITION: builder.vec3(eyes.positions, ARRAY_BUFFER),
          NORMAL: builder.vec3(computeNormals(eyes.positions, eyes.indices), ARRAY_BUFFER),
          COLOR_0: builder.accessor({
            bufferView: builder.view(colorBytes(eyes.colors, eyeVertexCount), ARRAY_BUFFER),
            componentType: UNSIGNED_BYTE,
            normalized: true,
            count: eyeVertexCount,
            type: "VEC4",
          }),
          ...singleJointSkin(builder, eyeJoints),
        },
        indices: builder.indices(eyes.indices),
        material: 1,
      },
    ],
  })

  const hairMesh = buildHair(hair, shape.vertices, normals, model.faces, regions, frame)
  if (hairMesh.indices.length > 0) {
    const hairCount = hairMesh.positions.length / 3
    meshes.push({
      name: "hair",
      primitives: [
        {
          attributes: {
            POSITION: builder.vec3(hairMesh.positions, ARRAY_BUFFER),
            NORMAL: builder.vec3(computeNormals(hairMesh.positions, hairMesh.indices), ARRAY_BUFFER),
            ...singleJointSkin(builder, new Uint8Array(hairCount).fill(head)),
          },
          indices: builder.indices(hairMesh.indices),
          material: 2,
        },
      ],
    })
  }

  // Joints: one node per bone, rest pose with identity rotations, so a joint's translation is its head relative to
  // its parent's head and its inverse bind matrix is a translation by minus its head.
  const boneCount = model.boneCount
  const jointBase = 1
  const nodes: Json[] = [{ name: "character", children: [] as number[] }]
  const children: number[][] = Array.from({ length: boneCount }, () => [])
  for (let bone = 1; bone < boneCount; bone++) children[model.boneParents[bone] ?? 0]?.push(jointBase + bone)
  const inverseBind = new Float32Array(boneCount * 16)
  for (let bone = 0; bone < boneCount; bone++) {
    const parent = bone === 0 ? -1 : (model.boneParents[bone] ?? 0)
    const headPoint = [0, 1, 2].map((axis) => shape.bones[bone * 3 + axis] ?? 0)
    const translation = [0, 1, 2].map(
      (axis) => (headPoint[axis] ?? 0) - (parent < 0 ? 0 : (shape.bones[parent * 3 + axis] ?? 0)),
    )
    const node: Json = { name: model.boneLabels[bone] ?? `bone${String(bone)}`, translation }
    const kids = children[bone] ?? []
    if (kids.length > 0) node["children"] = kids
    nodes.push(node)
    const matrix = inverseBind.subarray(bone * 16, bone * 16 + 16)
    matrix[0] = 1
    matrix[5] = 1
    matrix[10] = 1
    matrix[15] = 1
    matrix[12] = -(headPoint[0] ?? 0)
    matrix[13] = -(headPoint[1] ?? 0)
    matrix[14] = -(headPoint[2] ?? 0)
  }
  const inverseBindAccessor = builder.accessor({
    bufferView: builder.view(inverseBind),
    componentType: FLOAT,
    count: boneCount,
    type: "MAT4",
  })
  const meshNodes = meshes.map((mesh, index) => {
    nodes.push({ name: String(mesh["name"]), mesh: index, skin: 0 })
    return nodes.length - 1
  })
  nodes[0] = { name: "character", children: [jointBase] }

  const materials: Json[] = [
    {
      name: "skin",
      pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 },
      extras: { toon: true, shading: "toon" },
    },
    {
      name: "eyes",
      pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.3 },
      extras: { toon: true, shading: "toon" },
    },
    {
      name: "hair",
      pbrMetallicRoughness: {
        baseColorFactor: [...srgbToLinear(colors.hair), 1],
        metallicFactor: 0,
        roughnessFactor: 1,
      },
      doubleSided: true,
      extras: { toon: true, shading: "toon", style: hair.id },
    },
  ]

  const json: Json = {
    asset: { version: "2.0", generator: "eskais-character" },
    extensionsUsed: ["KHR_mesh_quantization"],
    extensionsRequired: ["KHR_mesh_quantization"],
    scene: 0,
    // Skinned meshes sit at the scene root: their parent transforms would not apply to them anyway.
    scenes: [{ name: "character", nodes: [0, ...meshNodes] }],
    nodes,
    meshes,
    materials,
    skins: [
      {
        name: "anny",
        inverseBindMatrices: inverseBindAccessor,
        skeleton: jointBase,
        joints: Array.from({ length: boneCount }, (_, bone) => jointBase + bone),
      },
    ],
    accessors: builder.accessors,
    bufferViews: builder.bufferViews,
    buffers: [{ byteLength: 0 }],
  }
  const binPad = (4 - (builder.byteLength % 4)) % 4
  const binLength = builder.byteLength + binPad
  ;(json["buffers"] as Json[])[0] = { byteLength: binLength }
  return { glb: packGlb(json, builder.chunks, binLength), targetNames, weights }
}
