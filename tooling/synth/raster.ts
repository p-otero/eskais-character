// A small deterministic software rasterizer. The synthetic set must be reproducible byte for byte on any machine, so
// the image guard can re-render a fixture and compare: no GPU, no driver, no random state.

export interface Mesh {
  positions: Float32Array
  /** Linear RGB per vertex, 0..1. */
  colors: Float32Array
  indices: Uint16Array | Uint32Array
  /** Extra shininess per vertex (eyes); 0 for skin. */
  gloss?: Float32Array
}

export interface Camera {
  eye: [number, number, number]
  target: [number, number, number]
  fovY: number
  width: number
  height: number
}

export interface Light {
  direction: [number, number, number]
  intensity: number
}

type Vec3 = [number, number, number]

function normalize(v: Vec3): Vec3 {
  const length = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) || 1
  return [v[0] / length, v[1] / length, v[2] / length]
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

export function vertexNormals(positions: Float32Array, indices: ArrayLike<number>): Float32Array {
  const normals = new Float32Array(positions.length)
  for (let t = 0; t < indices.length; t += 3) {
    const a = (indices[t] ?? 0) * 3
    const b = (indices[t + 1] ?? 0) * 3
    const c = (indices[t + 2] ?? 0) * 3
    const ab: Vec3 = [
      positions[b]! - positions[a]!,
      positions[b + 1]! - positions[a + 1]!,
      positions[b + 2]! - positions[a + 2]!,
    ]
    const ac: Vec3 = [
      positions[c]! - positions[a]!,
      positions[c + 1]! - positions[a + 1]!,
      positions[c + 2]! - positions[a + 2]!,
    ]
    const n = cross(ab, ac)
    for (const v of [a, b, c]) {
      normals[v] = normals[v]! + n[0]
      normals[v + 1] = normals[v + 1]! + n[1]
      normals[v + 2] = normals[v + 2]! + n[2]
    }
  }
  for (let v = 0; v < normals.length; v += 3) {
    const n = normalize([normals[v]!, normals[v + 1]!, normals[v + 2]!])
    normals[v] = n[0]
    normals[v + 1] = n[1]
    normals[v + 2] = n[2]
  }
  return normals
}

export interface Projected {
  /** Pixel x, pixel y, view depth per vertex. */
  screen: Float32Array
}

export function project(positions: Float32Array, camera: Camera): Float32Array {
  const forward = normalize([
    camera.target[0] - camera.eye[0],
    camera.target[1] - camera.eye[1],
    camera.target[2] - camera.eye[2],
  ])
  const right = normalize(cross(forward, [0, 1, 0]))
  const up = cross(right, forward)
  const focal = camera.height / 2 / Math.tan(camera.fovY / 2)
  const screen = new Float32Array((positions.length / 3) * 3)
  for (let v = 0; v < positions.length; v += 3) {
    const d: Vec3 = [
      positions[v]! - camera.eye[0],
      positions[v + 1]! - camera.eye[1],
      positions[v + 2]! - camera.eye[2],
    ]
    const z = d[0] * forward[0] + d[1] * forward[1] + d[2] * forward[2]
    const x = d[0] * right[0] + d[1] * right[1] + d[2] * right[2]
    const y = d[0] * up[0] + d[1] * up[1] + d[2] * up[2]
    screen[v] = camera.width / 2 + (focal * x) / z
    screen[v + 1] = camera.height / 2 - (focal * y) / z
    screen[v + 2] = z
  }
  return screen
}

export interface Frame {
  width: number
  height: number
  /** Linear RGB, 3 floats per pixel. */
  color: Float32Array
  depth: Float32Array
}

export function createFrame(width: number, height: number, background: (x: number, y: number) => Vec3): Frame {
  const color = new Float32Array(width * height * 3)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const c = background(x / width, y / height)
      const p = (y * width + x) * 3
      color[p] = c[0]
      color[p + 1] = c[1]
      color[p + 2] = c[2]
    }
  return { width, height, color, depth: new Float32Array(width * height).fill(Number.POSITIVE_INFINITY) }
}

export function drawMesh(frame: Frame, mesh: Mesh, camera: Camera, lights: Light[], ambient: number): void {
  const screen = project(mesh.positions, camera)
  const normals = vertexNormals(mesh.positions, mesh.indices)
  const view = normalize([
    camera.eye[0] - camera.target[0],
    camera.eye[1] - camera.target[1],
    camera.eye[2] - camera.target[2],
  ])
  const shaded = new Float32Array(mesh.positions.length)
  for (let v = 0; v < mesh.positions.length; v += 3) {
    const n: Vec3 = [normals[v]!, normals[v + 1]!, normals[v + 2]!]
    let diffuse = ambient
    let specular = 0
    for (const light of lights) {
      const l = normalize(light.direction)
      const lambert = Math.max(0, n[0] * l[0] + n[1] * l[1] + n[2] * l[2])
      diffuse += light.intensity * lambert
      const h = normalize([l[0] + view[0], l[1] + view[1], l[2] + view[2]])
      const nh = Math.max(0, n[0] * h[0] + n[1] * h[1] + n[2] * h[2])
      let power = nh
      for (let i = 0; i < 5; i++) power *= power
      specular += light.intensity * power * (0.04 + (mesh.gloss?.[v / 3] ?? 0))
    }
    shaded[v] = mesh.colors[v]! * diffuse + specular
    shaded[v + 1] = mesh.colors[v + 1]! * diffuse + specular
    shaded[v + 2] = mesh.colors[v + 2]! * diffuse + specular
  }
  const { width, height, color, depth } = frame
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const ia = mesh.indices[t]! * 3
    const ib = mesh.indices[t + 1]! * 3
    const ic = mesh.indices[t + 2]! * 3
    const ax = screen[ia]!
    const ay = screen[ia + 1]!
    const az = screen[ia + 2]!
    const bx = screen[ib]!
    const by = screen[ib + 1]!
    const bz = screen[ib + 2]!
    const cx = screen[ic]!
    const cy = screen[ic + 1]!
    const cz = screen[ic + 2]!
    if (az <= 0.01 || bz <= 0.01 || cz <= 0.01) continue
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
    if (area >= 0) continue // back face (screen y points down, front faces wind clockwise here)
    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)))
    const maxX = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)))
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)))
    const maxY = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)))
    // Perspective-correct interpolation of colour across the triangle.
    const iaz = 1 / az
    const ibz = 1 / bz
    const icz = 1 / cz
    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5
        const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area
        const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area
        const w2 = 1 - w0 - w1
        if (w0 < 0 || w1 < 0 || w2 < 0) continue
        const inverseZ = w0 * iaz + w1 * ibz + w2 * icz
        const z = 1 / inverseZ
        const pixel = y * width + x
        if (z >= depth[pixel]!) continue
        depth[pixel] = z
        const p0 = (w0 * iaz) / inverseZ
        const p1 = (w1 * ibz) / inverseZ
        const p2 = 1 - p0 - p1
        const out = pixel * 3
        color[out] = p0 * shaded[ia]! + p1 * shaded[ib]! + p2 * shaded[ic]!
        color[out + 1] = p0 * shaded[ia + 1]! + p1 * shaded[ib + 1]! + p2 * shaded[ic + 1]!
        color[out + 2] = p0 * shaded[ia + 2]! + p1 * shaded[ib + 2]! + p2 * shaded[ic + 2]!
      }
    }
  }
}

function linearToSrgbByte(value: number): number {
  const v = Math.min(Math.max(value, 0), 1)
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
  return Math.round(s * 255)
}

/** Box-downsamples a supersampled frame and converts it to 8-bit sRGB RGBA. */
export function resolve(frame: Frame, factor: number): { width: number; height: number; rgba: Uint8Array } {
  const width = Math.floor(frame.width / factor)
  const height = Math.floor(frame.height / factor)
  const rgba = new Uint8Array(width * height * 4)
  const samples = factor * factor
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let r = 0
      let g = 0
      let b = 0
      for (let sy = 0; sy < factor; sy++)
        for (let sx = 0; sx < factor; sx++) {
          const p = ((y * factor + sy) * frame.width + x * factor + sx) * 3
          r += frame.color[p]!
          g += frame.color[p + 1]!
          b += frame.color[p + 2]!
        }
      const out = (y * width + x) * 4
      rgba[out] = linearToSrgbByte(r / samples)
      rgba[out + 1] = linearToSrgbByte(g / samples)
      rgba[out + 2] = linearToSrgbByte(b / samples)
      rgba[out + 3] = 255
    }
  return { width, height, rgba }
}

export interface PickBuffer {
  width: number
  height: number
  /** Triangle index (into indices / 3) per pixel, -1 for none. */
  triangle: Int32Array
  /** Perspective-correct barycentric weights per pixel. */
  weights: Float32Array
  depth: Float32Array
}

/** Which triangle, and where on it, each pixel sees: maps detected 2D landmarks back onto the mesh. */
export function renderPick(
  positions: Float32Array,
  indices: ArrayLike<number>,
  camera: Camera,
  occluders: { positions: Float32Array; indices: ArrayLike<number> }[] = [],
): PickBuffer {
  const { width, height } = camera
  const triangle = new Int32Array(width * height).fill(-1)
  const weights = new Float32Array(width * height * 3)
  const depth = new Float32Array(width * height).fill(Number.POSITIVE_INFINITY)
  const pass = (points: Float32Array, list: ArrayLike<number>, record: boolean) => {
    const screen = project(points, camera)
    for (let t = 0; t < list.length; t += 3) {
      const ia = list[t]! * 3
      const ib = list[t + 1]! * 3
      const ic = list[t + 2]! * 3
      const ax = screen[ia]!,
        ay = screen[ia + 1]!,
        az = screen[ia + 2]!
      const bx = screen[ib]!,
        by = screen[ib + 1]!,
        bz = screen[ib + 2]!
      const cx = screen[ic]!,
        cy = screen[ic + 1]!,
        cz = screen[ic + 2]!
      const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
      if (area >= 0 || az <= 0.01 || bz <= 0.01 || cz <= 0.01) continue
      const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)))
      const maxX = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)))
      const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)))
      const maxY = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)))
      for (let y = minY; y <= maxY; y++)
        for (let x = minX; x <= maxX; x++) {
          const px = x + 0.5
          const py = y + 0.5
          const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area
          const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area
          const w2 = 1 - w0 - w1
          if (w0 < 0 || w1 < 0 || w2 < 0) continue
          const inverseZ = w0 / az + w1 / bz + w2 / cz
          const z = 1 / inverseZ
          const pixel = y * width + x
          if (z >= depth[pixel]!) continue
          depth[pixel] = z
          triangle[pixel] = record ? t / 3 : -1
          const p0 = w0 / az / inverseZ
          const p1 = w1 / bz / inverseZ
          weights[pixel * 3] = p0
          weights[pixel * 3 + 1] = p1
          weights[pixel * 3 + 2] = 1 - p0 - p1
        }
    }
  }
  pass(positions, indices, true)
  for (const occluder of occluders) pass(occluder.positions, occluder.indices, false)
  return { width, height, triangle, weights, depth }
}
