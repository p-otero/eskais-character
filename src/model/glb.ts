// The character as GLB. Morph targets move vertices, not joints: "base" has the mean-shape skeleton for live morphing,
// "character" the fitted one. Deltas are normalized SHORT (KHR_mesh_quantization, ~0.03 mm steps, half the float32
// size); head-only targets are sparse.

import { faceModifierWeights, type AnnyModel } from "./anny.ts"
import {
  ARRAY_BUFFER,
  FLOAT,
  GlbBuilder,
  UNSIGNED_BYTE,
  byteNormals,
  byteTarget,
  colorBytes,
  denseTarget,
  packGlb,
  singleJointSkin,
  sparseTarget,
  type Json,
} from "./glb-builder.ts"
import { buildClip, type ClipId } from "./clips.ts"
import { buildCharacter, neutralLook, type CharacterColors, type CharacterLook } from "./character.ts"
import type { HairStyle } from "./hair.ts"

export { computeNormals, srgbToLinear, type Rgb } from "./color-space.ts"
export type { CharacterColors } from "./character.ts"

export interface CharacterGlbInput {
  model: AnnyModel
  /** Body PCA coefficients: the weights of the body targets. */
  body: ArrayLike<number>
  /** Face modifier values in [-1, 1]: a positive value drives the "incr" target, a negative one the "decr" target. */
  face: ArrayLike<number>
  colors: CharacterColors
  hair: HairStyle
  /** Style, stylisation and outfit; defaults to the neutral look (no stylisation, no outfit). */
  look?: CharacterLook
  /**
   * A small file for demos: only these targets, quantized positions and normals, and byte targets scaled per target
   * (see `extras.targetScales`). Off by default: the engine's own exports keep every target at full precision.
   */
  compact?: CompactOptions
  /** Animation clips to include (demo assets); none by default. */
  clips?: readonly ClipId[]
  mode: "base" | "character"
}

export interface CompactOptions {
  /** How many body PCA targets to keep (from the first). */
  bodyTargets: number
  faceModifiers: readonly string[]
  /** ARKit names. */
  expressions: readonly string[]
}

export interface CharacterGlb {
  /** Scale per target in a compact GLB: send weight × scale (1 for every target otherwise). */
  targetScales?: Float32Array
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

/** The compact target set: chosen body, face and expression targets as scaled byte deltas, sparse where they move. */
function compactTargets(builder: GlbBuilder, model: AnnyModel, options: CompactOptions) {
  const vertexCount = model.vertexCount
  const targets: Json[] = []
  const names: string[] = []
  const scales: number[] = []
  // Movement under 0.2 mm is below what a 1 MB demo file needs to show.
  const add = (name: string, entries: { vertex: number; delta: [number, number, number] }[], epsilon = 2e-4) => {
    const { accessor, scale } = byteTarget(builder, vertexCount, entries, epsilon)
    targets.push({ POSITION: accessor })
    names.push(name)
    scales.push(scale)
  }
  for (let k = 0; k < Math.min(options.bodyTargets, model.bodyRank); k++) {
    const base = k * vertexCount * 3
    add(
      `body.pc${String(k).padStart(2, "0")}`,
      Array.from({ length: vertexCount }, (_, vertex) => ({
        vertex,
        delta: [0, 1, 2].map((axis) => model.bodyBasisVertices[base + vertex * 3 + axis] ?? 0) as [
          number,
          number,
          number,
        ],
      })),
    )
  }
  const subset = model.headSubset
  const subsetStride = subset.length * 3
  const headEntries = (block: Float32Array, target: number) =>
    Array.from(subset, (vertex, local) => ({
      vertex,
      delta: [0, 1, 2].map((axis) => block[target * subsetStride + local * 3 + axis] ?? 0) as [number, number, number],
    }))
  for (const label of options.faceModifiers) {
    const index = model.faceModifierLabels.indexOf(label)
    if (index < 0) throw new Error(`No face modifier "${label}".`)
    add(`face.${label}.incr`, headEntries(model.faceModifiers, 2 * index))
    add(`face.${label}.decr`, headEntries(model.faceModifiers, 2 * index + 1))
  }
  for (const label of options.expressions) {
    const index = model.facialActionLabels.indexOf(label)
    if (index < 0) throw new Error(`No expression "${label}".`)
    add(`expr.${label}`, headEntries(model.facialActions, index))
  }
  return { targets, names, scales: Float32Array.from(scales) }
}

export function writeCharacterGlb(input: CharacterGlbInput): CharacterGlb {
  const { model, mode } = input
  const look = input.look ?? neutralLook
  const vertexCount = model.vertexCount
  const targetNames = morphTargetNames(model)
  const built = buildCharacter({ ...input, compact: input.compact !== undefined })
  const weights =
    mode === "character" ? morphWeights(model, input.body, built.face) : new Float32Array(targetNames.length)
  const shape = { bones: built.bones }
  const [bodyMesh, ...extraMeshes] = built.meshes
  if (!bodyMesh) throw new Error("The character has no body.")

  // Anny keeps four influences per vertex; a slot whose weight rounded to 0 points at joint 0, as glTF recommends.
  const bodyJoints = Uint8Array.from(model.skinJoints, (joint, slot) =>
    (model.skinWeights[slot] ?? 0) > 0 ? joint : 0,
  )
  const builder = new GlbBuilder()
  const bodyAttributes: Json = {
    POSITION: builder.vec3(built.bodyBase, ARRAY_BUFFER),
    NORMAL: input.compact ? byteNormals(builder, bodyMesh.normals) : builder.vec3(bodyMesh.normals, ARRAY_BUFFER),
    COLOR_0: builder.accessor({
      bufferView: builder.view(colorBytes(bodyMesh.colors, vertexCount), ARRAY_BUFFER),
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
  const compact = input.compact
  let targets: Json[] = []
  let names = targetNames
  let scales: Float32Array | undefined
  if (compact) {
    ;({ targets, names, scales } = compactTargets(builder, model, compact))
    // Positions stay float: a stylised head reaches past the ±1 m a normalized short can hold.
  } else {
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
  }
  const fullWeights = weights
  const meshWeights = scales
    ? Float32Array.from(names, (name, index) => (fullWeights[targetNames.indexOf(name)] ?? 0) * (scales?.[index] ?? 1))
    : fullWeights

  const roles = { body: 0, eyes: 1, hair: 2 } as const
  const meshes: Json[] = [
    {
      name: "body",
      primitives: [{ attributes: bodyAttributes, indices: builder.indices(bodyMesh.indices), material: 0, targets }],
      weights: Array.from(meshWeights),
      extras: { targetNames: names, ...(scales ? { targetScales: Array.from(scales) } : {}) },
    },
  ]
  for (const mesh of extraMeshes) {
    const count = mesh.positions.length / 3
    meshes.push({
      name: mesh.name,
      primitives: [
        {
          attributes: {
            POSITION: builder.vec3(mesh.positions, ARRAY_BUFFER),
            NORMAL: compact ? byteNormals(builder, mesh.normals) : builder.vec3(mesh.normals, ARRAY_BUFFER),
            COLOR_0: builder.accessor({
              bufferView: builder.view(colorBytes(mesh.colors, count), ARRAY_BUFFER),
              componentType: UNSIGNED_BYTE,
              normalized: true,
              count,
              type: "VEC4",
            }),
            ...(mesh.skin
              ? {
                  JOINTS_0: builder.accessor({
                    bufferView: builder.view(mesh.skin.joints, ARRAY_BUFFER),
                    componentType: UNSIGNED_BYTE,
                    count,
                    type: "VEC4",
                  }),
                  WEIGHTS_0: builder.accessor({
                    bufferView: builder.view(mesh.skin.weights, ARRAY_BUFFER),
                    componentType: UNSIGNED_BYTE,
                    normalized: true,
                    count,
                    type: "VEC4",
                  }),
                }
              : singleJointSkin(builder, mesh.joint ?? new Uint8Array(count))),
          },
          indices: builder.indices(mesh.indices),
          material: roles[mesh.name],
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

  const styleExtras = (role: string) => ({ toon: true, shading: "toon", eskais: { role, style: look.style } })
  const materials: Json[] = [
    {
      name: "skin",
      pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 },
      extras: styleExtras("skin"),
    },
    {
      name: "eyes",
      pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.3 },
      extras: styleExtras("eyes"),
    },
    {
      name: "hair",
      pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 },
      doubleSided: true,
      extras: { ...styleExtras("hair"), hairStyle: input.hair.id },
    },
  ]

  const animations = (input.clips ?? []).map((id) => {
    const clip = buildClip(id, { boneLabels: model.boneLabels, bones: built.bones })
    const times = builder.accessor({
      bufferView: builder.view(new Float32Array(clip.times)),
      componentType: FLOAT,
      count: clip.times.length,
      type: "SCALAR",
      min: [clip.times[0] ?? 0],
      max: [clip.times.at(-1) ?? 0],
    })
    const samplers: Json[] = []
    const channels: Json[] = []
    for (const track of clip.tracks) {
      const bone = model.boneLabels.indexOf(track.bone)
      if (bone < 0) continue
      samplers.push({
        input: times,
        output: builder.accessor({
          bufferView: builder.view(new Float32Array(track.rotations.flat())),
          componentType: FLOAT,
          count: track.rotations.length,
          type: "VEC4",
        }),
        interpolation: "LINEAR",
      })
      channels.push({ sampler: samplers.length - 1, target: { node: jointBase + bone, path: "rotation" } })
    }
    return { name: clip.name, samplers, channels }
  })

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
    ...(animations.length > 0 ? { animations } : {}),
    accessors: builder.accessors,
    bufferViews: builder.bufferViews,
    buffers: [{ byteLength: 0 }],
  }
  const binPad = (4 - (builder.byteLength % 4)) % 4
  const binLength = builder.byteLength + binPad
  ;(json["buffers"] as Json[])[0] = { byteLength: binLength }
  return {
    glb: packGlb(json, builder.chunks, binLength),
    targetNames: names,
    weights: meshWeights,
    ...(scales ? { targetScales: scales } : {}),
  }
}
