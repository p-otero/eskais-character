// Demo clips. Rest joints are identity-rotated (an A-pose with the forearms hanging forward), so local axes are world
// axes at rest. The wave is posed from target directions on the rig: shortest-arc swings, then a palm twist spread over
// both forearm bones and the wrist so the skin doesn't candy-wrap.

export const clipIds = ["idle", "wave"] as const
export type ClipId = (typeof clipIds)[number]

export interface ClipTrack {
  bone: string
  /** Quaternions (x, y, z, w), one per key time, sign-continuous so linear interpolation takes the short way. */
  rotations: number[][]
}

export interface Clip {
  name: ClipId
  times: number[]
  tracks: ClipTrack[]
}

/** Rest joint heads, bone order, with the labels: what the wave is measured on. */
export interface ClipRig {
  boneLabels: readonly string[]
  bones: ArrayLike<number>
}

type Vec3 = [number, number, number]
type Quat = [number, number, number, number]

const identity: Quat = [0, 0, 0, 1]

function axisAngle(axis: Vec3, degrees: number): Quat {
  const half = (degrees * Math.PI) / 360
  const s = Math.sin(half)
  const n = normalize(axis)
  return [n[0] * s, n[1] * s, n[2] * s, Math.cos(half)]
}

function multiply(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a
  const [bx, by, bz, bw] = b
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ]
}

function conjugate(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]]
}

function rotate(q: Quat, v: Vec3): Vec3 {
  const p = multiply(multiply(q, [v[0], v[1], v[2], 0]), conjugate(q))
  return [p[0], p[1], p[2]]
}

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / length, v[1] / length, v[2] / length]
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

/** The shortest rotation taking direction a onto direction b. */
function swing(a: Vec3, b: Vec3): Quat {
  const u = normalize(a)
  const v = normalize(b)
  const c = dot(u, v)
  if (c > 0.999999) return identity
  if (c < -0.999999) {
    const axis = Math.abs(u[0]) < 0.9 ? cross(u, [1, 0, 0]) : cross(u, [0, 1, 0])
    return axisAngle(axis, 180)
  }
  const axis = cross(u, v)
  const q: Quat = [axis[0], axis[1], axis[2], 1 + c]
  const length = Math.hypot(...q)
  return [q[0] / length, q[1] / length, q[2] / length, q[3] / length]
}

function slerpDirection(a: Vec3, b: Vec3, t: number): Vec3 {
  const q = swing(a, b)
  const angle = 2 * Math.acos(Math.min(Math.max(q[3], -1), 1))
  if (angle < 1e-6) return normalize(b)
  const axis: Vec3 = [q[0], q[1], q[2]]
  return rotate(axisAngle(axis, (angle * t * 180) / Math.PI), normalize(a))
}

/** Signed angle about `axis` from a to b, both projected onto the plane normal to the axis. */
function twistAngle(axis: Vec3, a: Vec3, b: Vec3): number {
  const n = normalize(axis)
  const pa = normalize([a[0] - n[0] * dot(a, n), a[1] - n[1] * dot(a, n), a[2] - n[2] * dot(a, n)])
  const pb = normalize([b[0] - n[0] * dot(b, n), b[1] - n[1] * dot(b, n), b[2] - n[2] * dot(b, n)])
  return (Math.atan2(dot(cross(pa, pb), n), dot(pa, pb)) * 180) / Math.PI
}

function smooth(t: number): number {
  const s = Math.min(Math.max(t, 0), 1)
  return s * s * (3 - 2 * s)
}

function sampled(seconds: number, fps: number): number[] {
  const keys = Math.round(seconds * fps)
  return Array.from({ length: keys + 1 }, (_, index) => (seconds * index) / keys)
}

/** Keeps neighbouring keys in the same hemisphere: q and -q are one rotation, and interpolation must not flip. */
function continuous(rotations: Quat[]): number[][] {
  const out: Quat[] = []
  for (const q of rotations) {
    const previous = out.at(-1)
    out.push(
      previous && dot([q[0], q[1], q[2]], [previous[0], previous[1], previous[2]]) + q[3] * previous[3] < 0
        ? [-q[0], -q[1], -q[2], -q[3]]
        : q,
    )
  }
  return out
}

const idlePhase = (t: number) => Math.sin((2 * Math.PI * t) / 3)

function idle(): Clip {
  const phase = idlePhase
  const times = sampled(3, 10)
  return {
    name: "idle",
    times,
    tracks: [
      { bone: "spine03", rotations: continuous(times.map((t) => axisAngle([1, 0, 0], 1.6 * phase(t)))) },
      { bone: "spine01", rotations: continuous(times.map((t) => axisAngle([1, 0, 0], -0.8 * phase(t)))) },
      {
        bone: "neck01",
        rotations: continuous(times.map((t) => axisAngle([0, 1, 0], 3 * Math.sin((2 * Math.PI * t) / 3 + 1)))),
      },
      { bone: "upperarm01.L", rotations: continuous(times.map((t) => axisAngle([0, 0, 1], 2 * phase(t)))) },
      { bone: "upperarm01.R", rotations: continuous(times.map((t) => axisAngle([0, 0, 1], -2 * phase(t)))) },
    ],
  }
}

/**
 * A casual hello with the right hand (on -X): the arm out ~60° from the body, forearm up, palm forward beside the head;
 * three swings from elbow and wrist with shoulder follow-through, a head tilt and a lean; back to rest, so it loops
 * and crossfades into idle.
 */
function wave(rig: ClipRig): Clip {
  const point = (name: string): Vec3 => {
    const index = rig.boneLabels.indexOf(name)
    return [rig.bones[index * 3] ?? 0, rig.bones[index * 3 + 1] ?? 0, rig.bones[index * 3 + 2] ?? 0]
  }
  const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
  const shoulder = point("upperarm01.R")
  const elbow = point("lowerarm01.R")
  const wrist = point("wrist.R")
  const restUpper = normalize(sub(elbow, shoulder))
  const restFore = normalize(sub(wrist, elbow))
  // Palm normal at rest from the knuckles, signed to face the thigh (+X for the right hand).
  let restPalm = normalize(cross(sub(point("finger2-1.R"), wrist), sub(point("finger5-1.R"), wrist)))
  if (restPalm[0] < 0) restPalm = [-restPalm[0], -restPalm[1], -restPalm[2]]

  // About 60° from the body, out to the side and slightly forward; the forearm up and leaning in towards the head.
  const targetUpper = normalize([-Math.sin((60 * Math.PI) / 180), -Math.cos((60 * Math.PI) / 180), 0.12])
  const targetFore = normalize([0.04, 1, 0.02])
  // On the way up and down the hand passes out to the side, not across the chest (the shortest arc from the rest
  // pose, whose forearm hangs forward, would sweep it in front of the body).
  const sideFore = normalize([-1, 0.15, 0.15])
  const forward: Vec3 = [0, 0, 1]

  const raiseEnd = 0.55
  const waveEnd = 2.05
  const total = 2.7
  // 20 keys a second: smooth under linear interpolation, and small enough for a 1 MB demo file.
  const times = sampled(total, 20)
  const amount = (t: number) =>
    t < raiseEnd ? smooth(t / raiseEnd) : t > waveEnd ? 1 - smooth((t - waveEnd) / (total - waveEnd)) : 1
  // Three swings while the arm is up, easing in and out so the wave starts and stops softly.
  const swingAt = (t: number, lag: number) => {
    const local = (t - raiseEnd - lag) / (waveEnd - raiseEnd)
    if (local <= 0 || local >= 1) return 0
    const envelope = Math.sin(Math.PI * local)
    return Math.sin(2 * Math.PI * 3 * local) * envelope
  }

  const tracks: Record<string, Quat[]> = {
    "shoulder01.R": [],
    "upperarm01.R": [],
    "lowerarm01.R": [],
    "lowerarm02.R": [],
    "wrist.R": [],
    neck01: [],
    head: [],
    spine03: [],
    spine05: [],
  }
  for (const t of times) {
    const a = amount(t)
    const sway = swingAt(t, 0)
    const lagged = swingAt(t, 0.06)
    // Upper arm: swing towards the target, with a few degrees of follow-through as the hand swings.
    const upperDir = slerpDirection(restUpper, targetUpper, a)
    const upperWorld = multiply(axisAngle(forward, -3 * lagged * a), swing(restUpper, upperDir))
    // Forearm: from where the upper arm carried it, swing up to the target; the wave rocks it about the forward axis.
    const carried = rotate(upperWorld, restFore)
    const foreTarget =
      a < 0.5
        ? slerpDirection(restFore, sideFore, smooth(a / 0.5))
        : slerpDirection(sideFore, targetFore, smooth((a - 0.5) / 0.5))
    // Wider outwards than inwards, so the hand never crosses in front of the face.
    const swingDegrees = sway > 0 ? 12 : 30
    const waved = rotate(axisAngle(forward, -swingDegrees * sway * a), foreTarget)
    const foreSwing = multiply(swing(carried, waved), upperWorld)
    // Twist about the forearm so the palm faces forward, a share of it on each forearm bone and the wrist.
    const foreAxis = rotate(foreSwing, restFore)
    const twist = twistAngle(foreAxis, rotate(foreSwing, restPalm), forward) * a
    const elbowLocal = multiply(conjugate(upperWorld), foreSwing)
    const foreTwist = axisAngle(restFore, 0.55 * twist)
    const wristTwist = axisAngle(restFore, 0.45 * twist)
    // The wrist adds its own small lagging flick about the palm's normal (in its own frame, the rest palm normal).
    const wristFlick = axisAngle(restPalm, -12 * lagged * a)
    // A small shrug of the shoulder; the upper arm's rotation is then expressed under it.
    const shrug = axisAngle(forward, -4 * a)

    tracks["shoulder01.R"]!.push(shrug)
    tracks["upperarm01.R"]!.push(multiply(conjugate(shrug), upperWorld))
    tracks["lowerarm01.R"]!.push(elbowLocal)
    tracks["lowerarm02.R"]!.push(foreTwist)
    tracks["wrist.R"]!.push(multiply(wristTwist, wristFlick))
    tracks["neck01"]!.push(axisAngle(forward, 3 * a))
    tracks["head"]!.push(multiply(axisAngle(forward, 4 * a), axisAngle([0, 1, 0], -6 * a)))
    tracks["spine03"]!.push(axisAngle(forward, 1.5 * a))
    tracks["spine05"]!.push(axisAngle(forward, -2 * a))
  }
  return {
    name: "wave",
    times,
    tracks: Object.entries(tracks).map(([bone, rotations]) => ({ bone, rotations: continuous(rotations) })),
  }
}

export function buildClip(id: ClipId, rig?: ClipRig): Clip {
  if (id === "idle") return idle()
  if (!rig) throw new Error("The wave is measured on the rig: pass its rest joint heads.")
  return wave(rig)
}
