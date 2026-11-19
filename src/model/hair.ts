// Placeholder hair catalogue: procedural styles built from the fitted head, so they fit any head shape and need no
// third-party asset. The planned catalogue (MakeHuman "Hair 01", CC0) plugs in behind the same HairStyle record.

import { Region, type HeadFrame } from "./regions.ts"

export type HairLength = "none" | "buzz" | "short" | "medium" | "long"

export interface HairStyle {
  id: string
  label: string
  length: HairLength
  /** Cap thickness, metres. */
  thickness: number
  /** How far the back and sides fall, in eye distances below the eyes; 0 for no curtain. */
  fall: number
}

export const hairCatalogue: readonly HairStyle[] = [
  { id: "none", label: "No hair", length: "none", thickness: 0, fall: 0 },
  { id: "buzz", label: "Buzz cut", length: "buzz", thickness: 0, fall: 0 },
  { id: "short", label: "Short", length: "short", thickness: 0.007, fall: 0 },
  { id: "medium", label: "Medium", length: "medium", thickness: 0.01, fall: 2.3 },
  { id: "long", label: "Long", length: "long", thickness: 0.012, fall: 5.2 },
]

export function hairStyle(id: string): HairStyle {
  const style = hairCatalogue.find((candidate) => candidate.id === id)
  if (!style) throw new Error(`Unknown hair style "${id}".`)
  return style
}

export interface HairMesh {
  positions: Float32Array
  indices: Uint32Array
}

/** Hair geometry for a style over a shaped head: an offset shell over the scalp, plus a curtain for longer styles. */
export function buildHair(
  style: HairStyle,
  vertices: Float32Array,
  normals: Float32Array,
  faces: ArrayLike<number>,
  regions: Uint8Array,
  frame: HeadFrame,
): HairMesh {
  const positions: number[] = []
  const indices: number[] = []
  if (style.thickness <= 0) return { positions: new Float32Array(), indices: new Uint32Array() }
  const remap = new Map<number, number>()
  const capVertex = (v: number) => {
    const known = remap.get(v)
    if (known !== undefined) return known
    const index = positions.length / 3
    for (let axis = 0; axis < 3; axis++)
      positions.push((vertices[v * 3 + axis] ?? 0) + (normals[v * 3 + axis] ?? 0) * style.thickness)
    remap.set(v, index)
    return index
  }
  for (let t = 0; t < faces.length; t += 3) {
    const a = faces[t] ?? 0
    const b = faces[t + 1] ?? 0
    const c = faces[t + 2] ?? 0
    // A triangle with two scalp corners is kept too, so the shell reaches slightly past the painted hairline.
    const scalp = [a, b, c].filter((v) => regions[v] === Region.scalp).length
    if (scalp >= 2) indices.push(capVertex(a), capVertex(b), capVertex(c))
  }
  if (style.fall > 0) addCurtain(style, vertices, regions, frame, positions, indices)
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) }
}

function addCurtain(
  style: HairStyle,
  vertices: Float32Array,
  regions: Uint8Array,
  frame: HeadFrame,
  positions: number[],
  indices: number[],
): void {
  const [mx, my] = frame.eyeMid
  const d = frame.eyeDistance
  // Head axis: the centre of the scalp in the horizontal plane.
  let cz = 0
  let n = 0
  for (let v = 0; v < regions.length; v++)
    if (regions[v] === Region.scalp) {
      cz += vertices[v * 3 + 2] ?? 0
      n++
    }
  cz = n > 0 ? cz / n : frame.eyeMid[2] - d
  const columns = 40
  const rows = 14
  const sweep = (125 * Math.PI) / 180
  const top = my + 0.5 * d
  const bottom = my - style.fall * d
  // Radius of the head in each direction at the curtain's top, from the scalp vertices near that height.
  const radius = new Float64Array(columns + 1)
  for (let column = 0; column <= columns; column++) {
    const angle = -sweep + (2 * sweep * column) / columns
    const dx = Math.sin(angle)
    const dz = -Math.cos(angle)
    let best = 0.6 * d
    for (let v = 0; v < regions.length; v++) {
      const y = vertices[v * 3 + 1] ?? 0
      if (Math.abs(y - top) > 0.6 * d) continue
      const x = (vertices[v * 3] ?? 0) - mx
      const z = (vertices[v * 3 + 2] ?? 0) - cz
      const along = x * dx + z * dz
      const across = Math.abs(x * dz - z * dx)
      if (along > 0 && across < 0.15 * d) best = Math.max(best, along)
    }
    radius[column] = best + style.thickness
  }
  const base = positions.length / 3
  // Two layers, so each side of the curtain gets its own normals: the inside shows next to the face.
  for (let layer = 0; layer < 2; layer++)
    for (let row = 0; row <= rows; row++) {
      const t = row / rows
      const y = top + (bottom - top) * t
      const flare = 1 + 0.25 * t * Math.min(style.fall / 4, 1)
      for (let column = 0; column <= columns; column++) {
        const angle = -sweep + (2 * sweep * column) / columns
        const r = (radius[column] ?? d) * flare - layer * 0.002
        positions.push(mx + Math.sin(angle) * r, y, cz - Math.cos(angle) * r)
      }
    }
  const stride = columns + 1
  const layerSize = stride * (rows + 1)
  for (let row = 0; row < rows; row++)
    for (let column = 0; column < columns; column++) {
      const a = base + row * stride + column
      const b = a + 1
      const c = a + stride
      const e = c + 1
      indices.push(a, b, c, b, e, c)
      indices.push(a + layerSize, c + layerSize, b + layerSize, b + layerSize, c + layerSize, e + layerSize)
    }
}
