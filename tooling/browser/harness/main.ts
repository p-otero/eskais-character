// Test-only page: exposes the engine to Playwright. Images arrive as PNG bytes from the test runner and are synthetic
// (tooling/synth).
import { createScanEngine, type ScanEngine } from "../../../src/scan/engine.ts"
import type { ScanEvent } from "../../../src/scan/types.ts"

let engine: ScanEngine | undefined
const longTasks: number[] = []
new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) longTasks.push(entry.duration)
}).observe({ type: "longtask", buffered: true })

function blob(bytes: number[]): Blob {
  return new Blob([new Uint8Array(bytes)], { type: "image/png" })
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
