// The baked Anny body model (tooling/bake/bake_anny.py): an adult PCA body basis driven by Anny's phenotypes, face
// modifiers and ARKit-named facial actions over the head, and a 104-bone skin. Everything is linear in its weights,
// which is what lets the UI morph a character by interpolating numbers.

export const phenotypeLabels = ["gender", "age", "muscle", "weight", "height", "proportions"] as const
export type PhenotypeLabel = (typeof phenotypeLabels)[number]
export type Phenotype = Record<PhenotypeLabel, number>

/** Adult range of each phenotype in Anny's [0, 1] scale (age 0.6 is about 18 years, 1 about 90). */
export const phenotypeRange: Record<PhenotypeLabel, readonly [number, number]> = {
  gender: [0, 1],
  age: [0.6, 1],
  muscle: [0, 1],
  weight: [0, 1],
  height: [0, 1],
  proportions: [0, 1],
}

export const neutralPhenotype: Phenotype = {
  gender: 0.5,
  age: 0.7,
  muscle: 0.5,
  weight: 0.5,
  height: 0.5,
  proportions: 0.5,
}

interface LayoutEntry {
  offset: number
  dtype: "float32" | "int16" | "uint16" | "uint8"
  shape: number[]
  scale?: number
}

export interface AnnyManifest {
  format: "eskais-anny/1"
  sha256: string
  byteLength: number
  vertexCount: number
  boneCount: number
  phenotypeLabels: string[]
  phenotypeVariations: Record<string, string[]>
  phenotypeAnchors: Record<string, number[]>
  faceModifiers: string[]
  facialActions: string[]
  boneLabels: string[]
  bake: { bodyRank: number; pcaRmsErrorMm: number; pcaMaxErrorMm: number }
  layout: Record<string, LayoutEntry>
}

export interface AnnyModel {
  readonly manifest: AnnyManifest
  readonly vertexCount: number
  readonly boneCount: number
  readonly bodyRank: number
  readonly faceModifierLabels: readonly string[]
  readonly facialActionLabels: readonly string[]
  readonly boneLabels: readonly string[]
  readonly meanVertices: Float32Array
  readonly meanBones: Float32Array
  /** bodyRank × vertexCount × 3, metres. */
  readonly bodyBasisVertices: Float32Array
  readonly bodyBasisBones: Float32Array
  readonly phenotypeProjection: Float32Array
  readonly phenotypeOffset: Float32Array
  readonly phenotypeMask: Uint8Array
  readonly faces: Uint16Array
  readonly headSubset: Uint16Array
  /** faceModifiers × 2 (increase, decrease) × headSubset × 3. */
  readonly faceModifiers: Float32Array
  /** faceModifiers × 2 × boneCount × 3: how the face modifiers move the bone heads (eyes, head). */
  readonly faceModifierBones: Float32Array
  /** facialActions × headSubset × 3. */
  readonly facialActions: Float32Array
  readonly skinJoints: Uint8Array
  readonly skinWeights: Uint8Array
  readonly boneParents: Int16Array
}

function entry(manifest: AnnyManifest, name: string): LayoutEntry {
  const found = manifest.layout[name]
  if (!found) throw new Error(`The Anny asset has no "${name}" block.`)
  return found
}

function count(shape: number[]): number {
  return shape.reduce((product, size) => product * size, 1)
}

function readFloat(buffer: ArrayBuffer, manifest: AnnyManifest, name: string): Float32Array {
  const layout = entry(manifest, name)
  const length = count(layout.shape)
  if (layout.dtype === "float32") return new Float32Array(buffer, layout.offset, length)
  if (layout.dtype !== "int16") throw new Error(`"${name}" is ${layout.dtype}, not a float block.`)
  const quantized = new Int16Array(buffer, layout.offset, length)
  const scale = layout.scale ?? 1
  const out = new Float32Array(length)
  for (let index = 0; index < length; index++) out[index] = (quantized[index] ?? 0) * scale
  return out
}

function readInts<T extends Uint8Array | Uint16Array | Int16Array>(
  buffer: ArrayBuffer,
  manifest: AnnyManifest,
  name: string,
  Kind: new (buffer: ArrayBuffer, offset: number, length: number) => T,
): T {
  const layout = entry(manifest, name)
  return new Kind(buffer, layout.offset, count(layout.shape))
}

export function parseAnny(buffer: ArrayBuffer, manifest: AnnyManifest): AnnyModel {
  if (manifest.format !== "eskais-anny/1") throw new Error(`Unknown Anny asset format "${String(manifest.format)}".`)
  if (buffer.byteLength !== manifest.byteLength)
    throw new Error(
      `The Anny asset is ${String(buffer.byteLength)} bytes; the manifest says ${String(manifest.byteLength)}.`,
    )
  return {
    manifest,
    vertexCount: manifest.vertexCount,
    boneCount: manifest.boneCount,
    bodyRank: manifest.bake.bodyRank,
    faceModifierLabels: manifest.faceModifiers,
    facialActionLabels: manifest.facialActions,
    boneLabels: manifest.boneLabels,
    meanVertices: readFloat(buffer, manifest, "meanVertices"),
    meanBones: readFloat(buffer, manifest, "meanBones"),
    bodyBasisVertices: readFloat(buffer, manifest, "bodyBasisVertices"),
    bodyBasisBones: readFloat(buffer, manifest, "bodyBasisBones"),
    phenotypeProjection: readFloat(buffer, manifest, "phenotypeProjection"),
    phenotypeOffset: readFloat(buffer, manifest, "phenotypeOffset"),
    phenotypeMask: readInts(buffer, manifest, "phenotypeMask", Uint8Array),
    faces: readInts(buffer, manifest, "faces", Uint16Array),
    headSubset: readInts(buffer, manifest, "headSubset", Uint16Array),
    faceModifiers: readFloat(buffer, manifest, "faceModifiers"),
    faceModifierBones: readFloat(buffer, manifest, "faceModifierBones"),
    facialActions: readFloat(buffer, manifest, "facialActions"),
    skinJoints: readInts(buffer, manifest, "skinJoints", Uint8Array),
    skinWeights: readInts(buffer, manifest, "skinWeights", Uint8Array),
    boneParents: readInts(buffer, manifest, "boneParents", Int16Array),
  }
}

/** Anny's piecewise-linear anchor weights (anny.utils.interpolation, clamped). */
export function anchorWeights(value: number, anchors: readonly number[]): number[] {
  const n = anchors.length
  const first = anchors[0] ?? 0
  const last = anchors[n - 1] ?? 1
  const clamped = Math.min(Math.max(value, first), last)
  let upper = anchors.findIndex((anchor) => anchor >= clamped)
  upper = Math.min(Math.max(upper, 1), n - 1)
  const low = anchors[upper - 1] ?? first
  const high = anchors[upper] ?? last
  const alpha = (clamped - low) / (high - low)
  const weights = Array.from({ length: n }, () => 0)
  weights[upper - 1] = 1 - alpha
  weights[upper] = alpha
  return weights
}

/** Weights of Anny's 624 MakeHuman macro blendshapes for a phenotype (anny.models.phenotype). */
export function phenotypeBlendWeights(model: AnnyModel, phenotype: Phenotype): Float64Array {
  const { phenotypeVariations, phenotypeAnchors } = model.manifest
  const values: number[] = []
  for (const [feature, variations] of Object.entries(phenotypeVariations)) {
    if (feature === "race") {
      for (let index = 0; index < variations.length; index++) values.push(1 / 3)
      continue
    }
    const anchors = phenotypeAnchors[feature]
    if (!anchors) throw new Error(`No anchors for phenotype "${feature}".`)
    const value = (phenotype as Partial<Record<string, number>>)[feature] ?? 0.5
    values.push(...anchorWeights(value, anchors))
  }
  const variationCount = values.length
  const rows = model.phenotypeMask.length / variationCount
  const weights = new Float64Array(rows)
  for (let row = 0; row < rows; row++) {
    let product = 1
    for (let column = 0; column < variationCount; column++)
      if (model.phenotypeMask[row * variationCount + column]) product *= values[column] ?? 0
    weights[row] = product
  }
  return weights
}

/** PCA coefficients of the body for a phenotype: the body morph-target weights. */
export function bodyCoefficients(model: AnnyModel, phenotype: Phenotype): Float32Array {
  const weights = phenotypeBlendWeights(model, phenotype)
  const rank = model.bodyRank
  const coefficients = new Float32Array(rank)
  for (let k = 0; k < rank; k++) {
    let sum = model.phenotypeOffset[k] ?? 0
    for (let row = 0; row < weights.length; row++)
      sum += (weights[row] ?? 0) * (model.phenotypeProjection[row * rank + k] ?? 0)
    coefficients[k] = sum
  }
  return coefficients
}

/** Anny's local-change convention: a positive value drives the "increase" target, a negative one the "decrease". */
export function faceModifierWeights(values: ArrayLike<number>): Float32Array {
  const weights = new Float32Array(values.length * 2)
  for (let index = 0; index < values.length; index++) {
    const value = values[index] ?? 0
    weights[2 * index] = Math.max(value, 0)
    weights[2 * index + 1] = Math.max(-value, 0)
  }
  return weights
}

export interface ShapeWeights {
  body: ArrayLike<number>
  face?: ArrayLike<number>
  expression?: ArrayLike<number>
}

/** Rest-pose vertices (and bone heads) for the given morph weights. */
export function evaluateShape(
  model: AnnyModel,
  weights: ShapeWeights,
  out = new Float32Array(model.vertexCount * 3),
): { vertices: Float32Array; bones: Float32Array } {
  const stride = model.vertexCount * 3
  out.set(model.meanVertices)
  const bones = new Float32Array(model.meanBones)
  const boneStride = model.boneCount * 3
  for (let k = 0; k < model.bodyRank; k++) {
    const weight = weights.body[k] ?? 0
    if (weight === 0) continue
    const base = k * stride
    for (let index = 0; index < stride; index++)
      out[index] = (out[index] ?? 0) + weight * (model.bodyBasisVertices[base + index] ?? 0)
    const boneBase = k * boneStride
    for (let index = 0; index < boneStride; index++)
      bones[index] = (bones[index] ?? 0) + weight * (model.bodyBasisBones[boneBase + index] ?? 0)
  }
  const subset = model.headSubset
  const subsetStride = subset.length * 3
  const addHead = (block: Float32Array, base: number, weight: number) => {
    if (weight === 0) return
    for (let local = 0; local < subset.length; local++) {
      const vertex = (subset[local] ?? 0) * 3
      const from = base + local * 3
      out[vertex] = (out[vertex] ?? 0) + weight * (block[from] ?? 0)
      out[vertex + 1] = (out[vertex + 1] ?? 0) + weight * (block[from + 1] ?? 0)
      out[vertex + 2] = (out[vertex + 2] ?? 0) + weight * (block[from + 2] ?? 0)
    }
  }
  if (weights.face) {
    const split = faceModifierWeights(weights.face)
    for (let target = 0; target < split.length; target++) {
      const weight = split[target] ?? 0
      if (weight === 0) continue
      addHead(model.faceModifiers, target * subsetStride, weight)
      const base = target * boneStride
      for (let index = 0; index < boneStride; index++)
        bones[index] = (bones[index] ?? 0) + weight * (model.faceModifierBones[base + index] ?? 0)
    }
  }
  if (weights.expression)
    for (let target = 0; target < weights.expression.length; target++)
      addHead(model.facialActions, target * subsetStride, weights.expression[target] ?? 0)
  return { vertices: out, bones }
}
