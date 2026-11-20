// Linear blend skinning on the CPU: a character posed at a time in one of its clips, the same way a glTF viewer skins
// the GLB (rest joints are identity-rotated, so a joint's world transform is its parent's times its own rotation about
// its head). Deterministic, for the report's frame strips.

import type { AnnyModel } from "../../src/model/anny.ts"
import type { Character, CharacterMesh } from "../../src/model/character.ts"
import { computeNormals } from "../../src/model/color-space.ts"
import type { Clip } from "../../src/model/clips.ts"

type Quat = [number, number, number, number]

function slerp(a: number[], b: number[], t: number): Quat {
  let d = (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0) + (a[3] ?? 1) * (b[3] ?? 1)
  const sign = d < 0 ? -1 : 1
  d = Math.abs(d)
  let wa = 1 - t
  let wb = t
  if (d < 0.9995) {
    const angle = Math.acos(d)
    wa = Math.sin((1 - t) * angle) / Math.sin(angle)
    wb = Math.sin(t * angle) / Math.sin(angle)
  }
  const q = [0, 1, 2, 3].map((k) => wa * (a[k] ?? 0) + wb * sign * (b[k] ?? 0)) as Quat
  const length = Math.hypot(...q) || 1
  return q.map((value) => value / length) as Quat
}

/** Each bone's local rotation at time t (identity for bones the clip doesn't move). */
export function sampleClip(model: AnnyModel, clip: Clip, t: number): Quat[] {
  const rotations: Quat[] = Array.from({ length: model.boneCount }, () => [0, 0, 0, 1])
  const times = clip.times
  let k = times.findIndex((time) => time > t)
  if (k < 0) k = times.length - 1
  const k0 = Math.max(k - 1, 0)
  const span = (times[k] ?? 0) - (times[k0] ?? 0)
  const f = span > 0 ? (t - (times[k0] ?? 0)) / span : 0
  for (const track of clip.tracks) {
    const bone = model.boneLabels.indexOf(track.bone)
    if (bone < 0) continue
    rotations[bone] = slerp(
      track.rotations[k0] ?? [0, 0, 0, 1],
      track.rotations[k] ?? [0, 0, 0, 1],
      Math.min(Math.max(f, 0), 1),
    )
  }
  return rotations
}

/** 3×4 world skinning matrices (rotation and translation, row-major), one per bone. */
function skinningMatrices(model: AnnyModel, heads: ArrayLike<number>, locals: Quat[]): Float64Array {
  const world = new Float64Array(model.boneCount * 12)
  const rotationMatrix = (q: Quat) => {
    const [x, y, z, w] = q
    return [
      1 - 2 * (y * y + z * z),
      2 * (x * y - z * w),
      2 * (x * z + y * w),
      2 * (x * y + z * w),
      1 - 2 * (x * x + z * z),
      2 * (y * z - x * w),
      2 * (x * z - y * w),
      2 * (y * z + x * w),
      1 - 2 * (x * x + y * y),
    ]
  }
  // Bones are stored parent first, so one pass composes the chain.
  for (let bone = 0; bone < model.boneCount; bone++) {
    const r = rotationMatrix(locals[bone] ?? [0, 0, 0, 1])
    const h = [heads[bone * 3] ?? 0, heads[bone * 3 + 1] ?? 0, heads[bone * 3 + 2] ?? 0]
    // Local transform: rotate about the bone's own head.
    const local = [
      r[0]!,
      r[1]!,
      r[2]!,
      h[0]! - (r[0]! * h[0]! + r[1]! * h[1]! + r[2]! * h[2]!),
      r[3]!,
      r[4]!,
      r[5]!,
      h[1]! - (r[3]! * h[0]! + r[4]! * h[1]! + r[5]! * h[2]!),
      r[6]!,
      r[7]!,
      r[8]!,
      h[2]! - (r[6]! * h[0]! + r[7]! * h[1]! + r[8]! * h[2]!),
    ]
    const parent = bone === 0 ? -1 : (model.boneParents[bone] ?? 0)
    if (parent < 0 || parent === bone) {
      world.set(local, bone * 12)
      continue
    }
    const p = world.subarray(parent * 12, parent * 12 + 12)
    for (let row = 0; row < 3; row++)
      for (let column = 0; column < 4; column++) {
        let value = column === 3 ? (p[row * 4 + 3] ?? 0) : 0
        for (let k = 0; k < 3; k++) value += (p[row * 4 + k] ?? 0) * (local[k * 4 + column] ?? 0)
        world[bone * 12 + row * 4 + column] = value
      }
  }
  return world
}

function skinMesh(
  mesh: CharacterMesh,
  matrices: Float64Array,
  joints: ArrayLike<number>,
  weights: ArrayLike<number>,
  perVertex: number,
): CharacterMesh {
  const count = mesh.positions.length / 3
  const positions = new Float32Array(mesh.positions.length)
  for (let v = 0; v < count; v++) {
    const x = mesh.positions[v * 3] ?? 0
    const y = mesh.positions[v * 3 + 1] ?? 0
    const z = mesh.positions[v * 3 + 2] ?? 0
    let ox = 0
    let oy = 0
    let oz = 0
    for (let slot = 0; slot < perVertex; slot++) {
      const w = (weights[v * perVertex + slot] ?? 0) / 255
      if (w === 0) continue
      const m = (joints[v * perVertex + slot] ?? 0) * 12
      ox +=
        w * ((matrices[m] ?? 1) * x + (matrices[m + 1] ?? 0) * y + (matrices[m + 2] ?? 0) * z + (matrices[m + 3] ?? 0))
      oy +=
        w *
        ((matrices[m + 4] ?? 0) * x + (matrices[m + 5] ?? 1) * y + (matrices[m + 6] ?? 0) * z + (matrices[m + 7] ?? 0))
      oz +=
        w *
        ((matrices[m + 8] ?? 0) * x +
          (matrices[m + 9] ?? 0) * y +
          (matrices[m + 10] ?? 1) * z +
          (matrices[m + 11] ?? 0))
    }
    positions[v * 3] = ox
    positions[v * 3 + 1] = oy
    positions[v * 3 + 2] = oz
  }
  return { ...mesh, positions, normals: computeNormals(positions, mesh.indices) }
}

/** The character's meshes posed by the given local rotations. */
export function poseCharacter(model: AnnyModel, character: Character, locals: Quat[]): CharacterMesh[] {
  const matrices = skinningMatrices(model, character.bones, locals)
  return character.meshes.map((mesh) => {
    if (mesh.name === "body") return skinMesh(mesh, matrices, model.skinJoints, model.skinWeights, 4)
    if (mesh.skin) return skinMesh(mesh, matrices, mesh.skin.joints, mesh.skin.weights, 4)
    const count = mesh.positions.length / 3
    return skinMesh(mesh, matrices, mesh.joint ?? new Uint8Array(count), new Uint8Array(count).fill(255), 1)
  })
}
