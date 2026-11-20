// Colour space and normals, shared by the character builder, the GLB writer and the renderer.

/** sRGB, 0..255 per channel. */
export type Rgb = [number, number, number]

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
