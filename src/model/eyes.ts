import type { HeadFrame } from "./regions.ts"
import { icosphere } from "./sphere.ts"

export interface ColoredMesh {
  positions: Float32Array
  /** Linear RGB per vertex. */
  colors: Float32Array
  indices: Uint16Array
}

const sclera: [number, number, number] = [0.8, 0.78, 0.74]
const pupil: [number, number, number] = [0.01, 0.01, 0.012]
const highlight: [number, number, number] = [1, 1, 1]

export interface EyeOptions {
  /** Toon eyes: a larger iris with a dark rim and a painted highlight; false draws photo-like eyes. */
  stylized?: boolean
  /** Sphere subdivisions: 4 by default for toon eyes; compact files use 3. */
  detail?: number
  /** Eyeball scale on top of Anny's (the stylised look enlarges the eyes). */
  scale?: number
}

/** Two eyeballs looking down +Z, with the iris in `iris` (linear RGB). */
export function eyeballs(frame: HeadFrame, iris: [number, number, number], options: EyeOptions = {}): ColoredMesh {
  const stylized = options.stylized ?? false
  const sphere = icosphere(options.detail ?? (stylized ? 4 : 3))
  const radius = frame.eyeRadius * (options.scale ?? 1)
  // Cosines of the angular radii, measured from the gaze axis.
  const pupilEdge = stylized ? 0.955 : 0.975
  const irisEdge = stylized ? 0.8 : 0.9
  const rimEdge = stylized ? 0.825 : irisEdge
  const rim = iris.map((channel) => channel * 0.35) as [number, number, number]
  const lighter = iris.map((channel) => Math.min(1, channel * 1.6 + 0.04)) as [number, number, number]
  const count = sphere.positions.length / 3
  const positions = new Float32Array(count * 6)
  const colors = new Float32Array(count * 6)
  const indices = new Uint16Array(sphere.indices.length * 2)
  ;[frame.eyeLeft, frame.eyeRight].forEach((centre, eye) => {
    for (let v = 0; v < count; v++) {
      const nx = sphere.positions[v * 3] ?? 0
      const ny = sphere.positions[v * 3 + 1] ?? 0
      const nz = sphere.positions[v * 3 + 2] ?? 0
      const out = (eye * count + v) * 3
      positions[out] = centre[0] + nx * radius
      positions[out + 1] = centre[1] + ny * radius
      positions[out + 2] = centre[2] + nz * radius
      let color = sclera
      if (nz > pupilEdge) color = pupil
      else if (nz > rimEdge) color = stylized && ny < -0.15 ? lighter : iris
      else if (nz > irisEdge) color = rim
      // The painted highlight: a small disc up and to the outer side of the pupil, the same on both eyes.
      if (stylized && Math.hypot(nx - 0.2, ny - 0.1) < 0.085 && nz > 0) color = highlight
      colors.set(color, out)
    }
    for (let i = 0; i < sphere.indices.length; i++)
      indices[eye * sphere.indices.length + i] = (sphere.indices[i] ?? 0) + eye * count
  })
  return { positions, colors, indices }
}
