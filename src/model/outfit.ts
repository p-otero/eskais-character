// The default outfit, made in this repo: garments are shells of the fitted body itself (its vertices pushed out along
// their normals by a garment's ease), so they follow every morph and the rig with no extra skinning, and the
// underwear-fitted body stays internal. Membership is smoothed over the mesh so hems are clean and there are no cracks.

import type { AnnyModel } from "./anny.ts"

export const outfitIds = ["casual", "hoodie", "none"] as const
export type OutfitId = (typeof outfitIds)[number]

export type GarmentId = "top" | "bottom" | "shoes" | "sole"

export interface OutfitPalette {
  top: [number, number, number]
  bottom: [number, number, number]
  shoes: [number, number, number]
  sole: [number, number, number]
}

/** sRGB colours of each outfit. */
export const outfitPalettes: Record<Exclude<OutfitId, "none">, OutfitPalette> = {
  casual: { top: [72, 104, 158], bottom: [46, 49, 56], shoes: [236, 236, 232], sole: [150, 152, 158] },
  hoodie: { top: [120, 146, 116], bottom: [52, 55, 66], shoes: [236, 236, 232], sole: [150, 152, 158] },
}

/** Ease in metres: how far each garment stands off the skin. */
const ease: Record<GarmentId, number> = { top: 0.011, bottom: 0.02, shoes: 0.02, sole: 0.024 }

const torsoBones = /^(root|pelvis|spine|clavicle|shoulder01|breast)/
const upperArmBones = /^upperarm/
const forearmBones = /^(lowerarm)/
const legBones = /^(upperleg|lowerleg)/
const footBones = /^(foot|toe)/

export interface DressedBody {
  /** Vertices with the garments' ease applied. */
  vertices: Float32Array
  /** Garment of each vertex, or null for skin. */
  garment: (GarmentId | null)[]
}

function neighbours(model: AnnyModel): number[][] {
  const list: Set<number>[] = Array.from({ length: model.vertexCount }, () => new Set<number>())
  const faces = model.faces
  for (let t = 0; t < faces.length; t += 3) {
    const a = faces[t] ?? 0
    const b = faces[t + 1] ?? 0
    const c = faces[t + 2] ?? 0
    list[a]?.add(b).add(c)
    list[b]?.add(a).add(c)
    list[c]?.add(a).add(b)
  }
  return list.map((set) => [...set])
}

let neighbourCache: { model: AnnyModel; list: number[][] } | undefined

export function dressBody(
  model: AnnyModel,
  vertices: Float32Array,
  normals: Float32Array,
  bones: Float32Array,
  outfit: OutfitId,
): DressedBody {
  const garment: (GarmentId | null)[] = Array.from({ length: model.vertexCount }, () => null)
  if (outfit === "none") return { vertices: new Float32Array(vertices), garment }
  if (neighbourCache?.model !== model) neighbourCache = { model, list: neighbours(model) }
  const adjacency = neighbourCache.list
  const boneY = (name: string) => bones[model.boneLabels.indexOf(name) * 3 + 1] ?? 0
  const neckline = boneY("neck01") - 0.035
  const waist = (boneY("spine04") + boneY("spine05")) / 2 + 0.02
  const ankle = (boneY("foot.L") + boneY("foot.R")) / 2 + 0.035
  const bonePoint = (name: string) => {
    const index = model.boneLabels.indexOf(name)
    return [bones[index * 3] ?? 0, bones[index * 3 + 1] ?? 0, bones[index * 3 + 2] ?? 0]
  }
  // Sleeves end halfway down the upper arm, measured along the arm so the hem is square to it.
  const arms = (["L", "R"] as const).map((side) => ({
    from: bonePoint(`upperarm01.${side}`),
    to: bonePoint(`lowerarm01.${side}`),
  }))
  const alongArm = (v: number) => {
    const x = vertices[v * 3] ?? 0
    const arm = x >= 0 ? arms[0] : arms[1]
    if (!arm) return 0
    const d = [0, 1, 2].map((axis) => (arm.to[axis] ?? 0) - (arm.from[axis] ?? 0))
    const p = [0, 1, 2].map((axis) => (vertices[v * 3 + axis] ?? 0) - (arm.from[axis] ?? 0))
    const dd = (d[0] ?? 0) ** 2 + (d[1] ?? 0) ** 2 + (d[2] ?? 0) ** 2 || 1
    return ((p[0] ?? 0) * (d[0] ?? 0) + (p[1] ?? 0) * (d[1] ?? 0) + (p[2] ?? 0) * (d[2] ?? 0)) / dd
  }
  const sleeveEnd = outfit === "hoodie" ? Number.POSITIVE_INFINITY : 0.5
  let floor = Number.POSITIVE_INFINITY
  for (let v = 1; v < vertices.length; v += 3) floor = Math.min(floor, vertices[v] ?? 0)

  const raw = new Uint8Array(model.vertexCount)
  const codes: GarmentId[] = ["top", "bottom", "shoes", "sole"]
  for (let v = 0; v < model.vertexCount; v++) {
    const bone = model.boneLabels[model.skinJoints[v * 4] ?? 0] ?? ""
    const y = vertices[v * 3 + 1] ?? 0
    let code = 0
    if (footBones.test(bone) || (legBones.test(bone) && y < ankle)) code = y < floor + 0.022 ? 4 : 3
    else if (legBones.test(bone) || (torsoBones.test(bone) && y < waist)) code = 2
    else if (torsoBones.test(bone) && y < neckline) code = 1
    else if (upperArmBones.test(bone) && alongArm(v) < sleeveEnd) code = 1
    else if (forearmBones.test(bone) && outfit === "hoodie") code = 1
    raw[v] = code
  }
  // Smoothed membership per garment: the ease fades over a couple of edge rings instead of stepping at the hem.
  const out = new Float32Array(vertices)
  for (const [index, id] of codes.entries()) {
    let field = Float32Array.from(raw, (code) => (code === index + 1 ? 1 : 0))
    for (let pass = 0; pass < 3; pass++) {
      const next = new Float32Array(field.length)
      for (let v = 0; v < field.length; v++) {
        const around = adjacency[v] ?? []
        let sum = field[v] ?? 0
        for (const n of around) sum += field[n] ?? 0
        next[v] = sum / (around.length + 1)
      }
      field = next
    }
    const amount = ease[id]
    for (let v = 0; v < field.length; v++) {
      const weight = field[v] ?? 0
      if (weight <= 0) continue
      for (let axis = 0; axis < 3; axis++)
        out[v * 3 + axis] = (out[v * 3 + axis] ?? 0) + (normals[v * 3 + axis] ?? 0) * amount * weight
      if (raw[v] === index + 1) garment[v] = id
    }
  }
  // Flat soles: nothing of a shoe dips below the floor it stands on.
  for (let v = 0; v < model.vertexCount; v++)
    if (garment[v] === "sole" || garment[v] === "shoes") out[v * 3 + 1] = Math.max(out[v * 3 + 1] ?? 0, floor - 0.004)
  return { vertices: out, garment }
}
