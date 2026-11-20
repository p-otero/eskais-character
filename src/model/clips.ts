// Small built-in animation clips for demos: an idle loop and a wave. The rig's rest pose has identity joint rotations
// in an A-pose, so a joint's local axes are the world axes (+X the character's left, +Y up, +Z forward) and each key
// is a plain rotation about them.

export const clipIds = ["idle", "wave"] as const
export type ClipId = (typeof clipIds)[number]

export interface ClipTrack {
  bone: string
  /** Quaternions (x, y, z, w), one per key time. */
  rotations: number[][]
}

export interface Clip {
  name: ClipId
  times: number[]
  tracks: ClipTrack[]
}

function axisAngle(axis: [number, number, number], degrees: number): number[] {
  const half = (degrees * Math.PI) / 360
  const s = Math.sin(half)
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(half)]
}

function multiply(a: number[], b: number[]): number[] {
  const [ax = 0, ay = 0, az = 0, aw = 1] = a
  const [bx = 0, by = 0, bz = 0, bw = 1] = b
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ]
}

const X: [number, number, number] = [1, 0, 0]
const Y: [number, number, number] = [0, 1, 0]
const Z: [number, number, number] = [0, 0, 1]

const idlePhase = (t: number) => Math.sin((2 * Math.PI * t) / 3)

function waveRaise(t: number): number {
  const up = Math.min(t / 0.4, 1)
  const down = Math.min(Math.max((2.4 - t) / 0.4, 0), 1)
  const s = Math.min(up, down)
  return s * s * (3 - 2 * s)
}

const waveSwing = (t: number) => Math.sin(2 * Math.PI * 2.2 * t)

function sampled(seconds: number, keys: number): number[] {
  return Array.from({ length: keys + 1 }, (_, index) => (seconds * index) / keys)
}

export function buildClip(id: ClipId): Clip {
  if (id === "idle") {
    const times = sampled(3, 12)
    const phase = idlePhase
    return {
      name: "idle",
      times,
      tracks: [
        { bone: "spine03", rotations: times.map((t) => axisAngle(X, 1.6 * phase(t))) },
        { bone: "spine01", rotations: times.map((t) => axisAngle(X, -0.8 * phase(t))) },
        { bone: "neck01", rotations: times.map((t) => axisAngle(Y, 3 * Math.sin((2 * Math.PI * t) / 3 + 1))) },
        { bone: "upperarm01.L", rotations: times.map((t) => axisAngle(Z, 2 * phase(t))) },
        { bone: "upperarm01.R", rotations: times.map((t) => axisAngle(Z, -2 * phase(t))) },
      ],
    }
  }
  // Wave: the right arm (on -X) swings up beside the head and the forearm waves from the elbow.
  const times = sampled(2.4, 24)
  const raise = waveRaise
  const wave = waveSwing
  return {
    name: "wave",
    times,
    tracks: [
      {
        bone: "upperarm01.R",
        rotations: times.map((t) => multiply(axisAngle(Z, -112 * raise(t)), axisAngle(Y, 12 * raise(t)))),
      },
      { bone: "lowerarm01.R", rotations: times.map((t) => axisAngle(Z, (-35 + 22 * wave(t)) * raise(t))) },
      { bone: "wrist.R", rotations: times.map((t) => axisAngle(Z, 10 * wave(t) * raise(t))) },
      { bone: "neck01", rotations: times.map((t) => axisAngle(Y, -8 * raise(t))) },
    ],
  }
}
