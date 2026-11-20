// Test-only page: exposes the engine to Playwright. Images arrive as PNG bytes from the test runner and are synthetic
// (tooling/synth).
import * as THREE from "three"
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js"
import { createScanEngine, type ScanEngine } from "../../../src/scan/engine.ts"
import { styleCharacter, type StyleId } from "../../../src/three/index.ts"
import type { Character, ScanEvent } from "../../../src/scan/types.ts"

let engine: ScanEngine | undefined
let lastCharacter: Character | undefined
const longTasks: number[] = []
new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) longTasks.push(entry.duration)
}).observe({ type: "longtask", buffered: true })

function blob(bytes: number[]): Blob {
  return new Blob([new Uint8Array(bytes)], { type: "image/png" })
}

/** Large binaries cross to Playwright as base64: a number array of a 6 MB GLB would be far bigger. */
async function base64(bytes: Uint8Array): Promise<string> {
  const url = await new Promise<string>((resolve) => {
    const reader = new FileReader()
    reader.addEventListener("load", () => resolve(String(reader.result)))
    reader.readAsDataURL(new Blob([bytes.slice()]))
  })
  return url.slice(url.indexOf(",") + 1)
}

async function renderStyled(glb: Uint8Array, style: StyleId | null, clip: string | null, time: number, angle: number) {
  const canvas = document.createElement("canvas")
  canvas.width = 360
  canvas.height = 640
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true })
  renderer.setClearColor(0xdde3ea)
  const gltf = await new GLTFLoader().parseAsync(glb.slice().buffer, "")
  const scene = new THREE.Scene()
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.2))
  const sun = new THREE.DirectionalLight(0xffffff, 2.2)
  sun.position.set(1.5, 2.5, 3)
  scene.add(sun, gltf.scene)
  if (style) styleCharacter(gltf.scene, { style })
  if (clip) {
    const mixer = new THREE.AnimationMixer(gltf.scene)
    const action = gltf.animations.find((item) => item.name === clip)
    if (action) mixer.clipAction(action).play()
    mixer.setTime(time)
  }
  const camera = new THREE.PerspectiveCamera(30, 360 / 640, 0.1, 20)
  camera.position.set(Math.sin(angle) * 4.6, 0.15, Math.cos(angle) * 4.6)
  camera.lookAt(0, 0, 0)
  renderer.render(scene, camera)
  const pixels = new Uint8Array(360 * 640 * 4)
  const gl = renderer.getContext()
  gl.readPixels(0, 0, 360, 640, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
  let covered = 0
  for (let index = 0; index < pixels.length; index += 4)
    if (
      Math.abs((pixels[index] ?? 0) - 0xdd) +
        Math.abs((pixels[index + 1] ?? 0) - 0xe3) +
        Math.abs((pixels[index + 2] ?? 0) - 0xea) >
      24
    )
      covered++
  const url = canvas.toDataURL("image/png")
  renderer.dispose()
  return { url, covered, clips: gltf.animations.map((item) => item.name) }
}

const harness = {
  async init(delegate: "CPU" | "GPU" | "auto", poseModel: "lite" | "full") {
    engine = createScanEngine({ delegate, poseModel })
    return engine.ready
  },
  async detect(kind: "face" | "body", bytes: number[]) {
    const result = await engine!.detect(kind, blob(bytes))
    return {
      landmarks: result.landmarks ? Array.from(result.landmarks) : null,
      blendshapes: result.blendshapes,
      features: result.features,
      ms: result.ms,
    }
  },
  /**
   * Draws a GLB with the reference three.js styles (WebGL, SwiftShader in tests) and returns a PNG data URL plus how
   * many pixels differ from the background, for the styles test and visual checks.
   */
  async renderGlb(
    bytes: number[],
    style: StyleId | null,
    clip: string | null,
    time: number,
    angle: number,
    restyle?: { style?: StyleId; hair?: string },
  ) {
    let glb: Uint8Array = new Uint8Array(bytes)
    if (restyle && lastCharacter) glb = (await engine!.restyle(lastCharacter, restyle)).glb
    return renderStyled(glb, style, clip, time, angle)
  },
  /** The local real-photo flow (tooling/local/scan-photo.ts): scan, then every style, rendered front and side. */
  async scanPhotos(
    face: { bytes: number[]; type: string },
    body: { bytes: number[]; type: string } | null,
    heightCm: number | null,
    stylize: number,
  ) {
    const started = performance.now()
    let character: Character | undefined
    for await (const event of engine!.scan(
      {
        face: new Blob([new Uint8Array(face.bytes)], { type: face.type }),
        ...(body ? { body: new Blob([new Uint8Array(body.bytes)], { type: body.type }) } : {}),
      },
      { ...(heightCm ? { hints: { heightCm } } : {}), look: { stylize } },
    )) {
      if (event.type === "error") return { error: event.error }
      if (event.type === "done") character = event.character
    }
    if (!character) return { error: { code: "internal", message: "No character." } }
    const scanMs = performance.now() - started
    const styles = []
    for (const style of character.look.styles) {
      const restyled = await engine!.restyle(character, { style: style.id })
      const front = await renderStyled(restyled.glb, style.id, null, 0, 0)
      const side = await renderStyled(restyled.glb, style.id, null, 0, Math.PI / 2.5)
      styles.push({ style: style.id, glb: await base64(restyled.glb), front: front.url, side: side.url })
    }
    return { params: character.params, colors: character.colors, hair: character.hair.id, styles, timings: { scanMs } }
  },
  async restyleLast(options: {
    style?: StyleId
    stylize?: number
    outfit?: "casual" | "hoodie" | "none"
    hair?: string
  }) {
    if (!lastCharacter) throw new Error("Scan first.")
    const next = await engine!.restyle(lastCharacter, options)
    return { look: next.look, hair: next.hair.id, glb: Array.from(next.glb) }
  },
  /** The full event stream of one scan with its data (no GLB bytes), for the docs' offline replay. */
  async scanStream(face: number[], body: number[]) {
    const started = performance.now()
    const events: Record<string, unknown>[] = []
    let character: Character | undefined
    for await (const event of engine!.scan({ face: blob(face), body: blob(body) })) {
      const at = Math.round(performance.now() - started)
      if (event.type === "landmarks")
        events.push({
          type: event.type,
          at,
          source: event.source,
          aspect: event.aspect,
          points: Array.from(event.points),
        })
      else if (event.type === "progress")
        events.push({ type: event.type, at, value: event.value, weights: Array.from(event.weights) })
      else if (event.type === "stage")
        events.push({
          type: event.type,
          at,
          stage: event.stage,
          ...(event.ms === undefined ? {} : { ms: Math.round(event.ms) }),
        })
      else if (event.type === "model") events.push({ type: event.type, at })
      else if (event.type === "done") {
        character = event.character
        events.push({ type: event.type, at, weights: Array.from(event.character.weights) })
      } else events.push({ type: event.type, at })
    }
    if (!character) throw new Error("No character.")
    const { params, colors, hair, look } = character
    return {
      events,
      character: { params, colors, hair: hair.id, look: { stylize: look.stylize, outfit: look.outfit } },
    }
  },
  longTasks: () => [...longTasks],
  resetLongTasks: () => void longTasks.splice(0),
  async memory() {
    const measure = (performance as unknown as { measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }> })
      .measureUserAgentSpecificMemory
    return measure && crossOriginIsolated ? (await measure.call(performance)).bytes : null
  },
  /** A scan of a blank, faceless image drawn here: the error path, with no image file involved. */
  async scanBlank() {
    const canvas = new OffscreenCanvas(320, 320)
    const context = canvas.getContext("2d")!
    context.fillStyle = "#9aa"
    context.fillRect(0, 0, 320, 320)
    const blank = await canvas.convertToBlob({ type: "image/png" })
    const events: ScanEvent[] = []
    for await (const event of engine!.scan({ face: blank })) events.push(event)
    return events.map((event) => (event.type === "error" ? event : { type: event.type }))
  },
  async scan(face: number[], body: number[] | null, heightCm?: number, light = false) {
    const events: { type: string; at: number; detail: unknown }[] = []
    const started = performance.now()
    let done: Extract<ScanEvent, { type: "done" }> | undefined
    for await (const event of engine!.scan(
      { face: blob(face), ...(body ? { body: blob(body) } : {}) },
      heightCm ? { hints: { heightCm } } : {},
    )) {
      const at = performance.now() - started
      if (event.type === "done") done = event
      events.push({
        type: event.type,
        at,
        detail:
          event.type === "stage"
            ? { stage: event.stage, ms: event.ms }
            : event.type === "progress"
              ? { value: event.value }
              : event.type === "model"
                ? { bytes: event.glb.byteLength, targets: event.targetNames.length }
                : null,
      })
    }
    if (!done) throw new Error("The scan ended without a character.")
    const { character } = done
    lastCharacter = character
    return {
      events,
      totalMs: performance.now() - started,
      params: character.params,
      colors: character.colors,
      hair: character.hair.id,
      quality: character.quality,
      glb: light ? [] : Array.from(character.glb),
      glbBytes: character.glb.byteLength,
      weights: Array.from(character.weights),
      targetNames: character.targetNames,
    }
  },
}

Object.assign(globalThis, { harness })
