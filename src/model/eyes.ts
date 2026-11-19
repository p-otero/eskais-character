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

/** Two eyeballs looking down +Z, with the iris in `iris` (linear RGB). */
export function eyeballs(frame: HeadFrame, iris: [number, number, number]): ColoredMesh {
  const sphere = icosphere(3)
  const radius = frame.eyeRadius
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
      const color = nz > 0.975 ? pupil : nz > 0.9 ? iris : sclera
      colors.set(color, out)
    }
    for (let i = 0; i < sphere.indices.length; i++)
      indices[eye * sphere.indices.length + i] = (sphere.indices[i] ?? 0) + eye * count
  })
  return { positions, colors, indices }
}
