// Stylised rendering for the report: the same style presets the GLB carries (ramp lighting, rim light, faceted
// shading, inverted-hull outline), shaded per pixel. Deterministic, like the photo renderer, so the image guard can
// re-render its output.

import type { CharacterMesh } from "../../src/model/character.ts"
import { rampLevel, type StylePreset } from "../../src/model/style.ts"
import { project, type Camera, type Frame } from "./raster.ts"

type Vec3 = [number, number, number]

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / length, v[1] / length, v[2] / length]
}

export interface ToonLight {
  direction: Vec3
  ambient: number
}

interface DrawOptions {
  /** Draw back faces only, pushed out along the normals: the inverted-hull outline pass. */
  hull?: { width: number; color: Vec3 }
}

function drawPass(
  frame: Frame,
  mesh: CharacterMesh,
  camera: Camera,
  light: ToonLight,
  preset: StylePreset,
  options: DrawOptions,
): void {
  const { positions, normals, colors, indices } = mesh
  const hull = options.hull
  const points = hull ? new Float32Array(positions.length) : positions
  if (hull) for (let i = 0; i < positions.length; i++) points[i] = (positions[i] ?? 0) + (normals[i] ?? 0) * hull.width
  const screen = project(points, camera)
  const l = normalize(light.direction)
  const eye = camera.eye
  const { width, height, color, depth } = frame
  for (let t = 0; t < indices.length; t += 3) {
    const ia = (indices[t] ?? 0) * 3
    const ib = (indices[t + 1] ?? 0) * 3
    const ic = (indices[t + 2] ?? 0) * 3
    const ax = screen[ia]!,
      ay = screen[ia + 1]!,
      az = screen[ia + 2]!
    const bx = screen[ib]!,
      by = screen[ib + 1]!,
      bz = screen[ib + 2]!
    const cx = screen[ic]!,
      cy = screen[ic + 1]!,
      cz = screen[ic + 2]!
    if (az <= 0.01 || bz <= 0.01 || cz <= 0.01) continue
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
    // Front faces have negative area here (screen y points down); the hull pass keeps the back faces instead.
    // Hair cards are thin and seen from both sides: hair draws back faces too, shaded with the normal flipped.
    const twoSided = mesh.name === "hair" && !hull
    const flip = twoSided && area > 0 ? -1 : 1
    if (!twoSided && (hull ? area <= 0 : area >= 0)) continue
    let faceNormal: Vec3 | null = null
    if (preset.flatShading && !hull) {
      const ux = points[ib]! - points[ia]!,
        uy = points[ib + 1]! - points[ia + 1]!,
        uz = points[ib + 2]! - points[ia + 2]!
      const vx = points[ic]! - points[ia]!,
        vy = points[ic + 1]! - points[ia + 1]!,
        vz = points[ic + 2]! - points[ia + 2]!
      faceNormal = normalize([uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx])
    }
    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)))
    const maxX = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)))
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)))
    const maxY = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)))
    const iaz = 1 / az,
      ibz = 1 / bz,
      icz = 1 / cz
    for (let y = minY; y <= maxY; y++)
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5
        const py = y + 0.5
        const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area
        const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area
        const w2 = 1 - w0 - w1
        if (w0 < 0 || w1 < 0 || w2 < 0) continue
        const inverseZ = w0 * iaz + w1 * ibz + w2 * icz
        const z = 1 / inverseZ
        const pixel = y * width + x
        // The hull is stored a little deeper than it is, so the surface it outlines always wins where both are drawn.
        const stored = hull ? z + hull.width * 3 : z
        if (stored >= depth[pixel]!) continue
        depth[pixel] = stored
        const out = pixel * 3
        if (hull) {
          color[out] = hull.color[0]
          color[out + 1] = hull.color[1]
          color[out + 2] = hull.color[2]
          continue
        }
        const p0 = (w0 * iaz) / inverseZ
        const p1 = (w1 * ibz) / inverseZ
        const p2 = 1 - p0 - p1
        const smooth =
          faceNormal ??
          normalize([
            p0 * normals[ia]! + p1 * normals[ib]! + p2 * normals[ic]!,
            p0 * normals[ia + 1]! + p1 * normals[ib + 1]! + p2 * normals[ic + 1]!,
            p0 * normals[ia + 2]! + p1 * normals[ib + 2]! + p2 * normals[ic + 2]!,
          ])
        const n: Vec3 = [smooth[0] * flip, smooth[1] * flip, smooth[2] * flip]
        const wx = p0 * points[ia]! + p1 * points[ib]! + p2 * points[ic]!
        const wy = p0 * points[ia + 1]! + p1 * points[ib + 1]! + p2 * points[ic + 1]!
        const wz = p0 * points[ia + 2]! + p1 * points[ib + 2]! + p2 * points[ic + 2]!
        const v = normalize([eye[0] - wx, eye[1] - wy, eye[2] - wz])
        const lambert = Math.max(0, n[0] * l[0] + n[1] * l[1] + n[2] * l[2])
        const level = light.ambient + (1 - light.ambient) * rampLevel(preset, lambert)
        const facing = Math.max(0, n[0] * v[0] + n[1] * v[1] + n[2] * v[2])
        const rim = preset.rim.strength * Math.pow(1 - facing, preset.rim.power)
        const h = normalize([l[0] + v[0], l[1] + v[1], l[2] + v[2]])
        const nh = Math.max(0, n[0] * h[0] + n[1] * h[1] + n[2] * h[2])
        // A toon highlight lives on the hair only; on skin it reads as a wet patch.
        const specular = mesh.name === "hair" ? preset.specular * (nh > 0.97 ? 1 : 0) : 0
        // Eyes keep their painted colours flat-lit, as toon eyes do.
        const shade = mesh.name === "eyes" ? 0.6 + 0.4 * level : level
        for (let k = 0; k < 3; k++) {
          const base = colors[ia + k]! * p0 + colors[ib + k]! * p1 + colors[ic + k]! * p2
          // The rim brightens the surface's own colour, so dark skin gets a warm edge, not a white halo.
          color[out + k] = base * (shade + rim * 2) + specular
        }
      }
  }
}

/** Draws a character in a style: outline hulls first, then the shaded meshes. */
export function drawCharacter(
  frame: Frame,
  meshes: CharacterMesh[],
  camera: Camera,
  light: ToonLight,
  preset: StylePreset,
): void {
  if (preset.outline.width > 0)
    for (const mesh of meshes)
      if (mesh.name !== "eyes")
        drawPass(frame, mesh, camera, light, preset, {
          hull: { width: preset.outline.width, color: preset.outline.color },
        })
  for (const mesh of meshes) drawPass(frame, mesh, camera, light, preset, {})
}
