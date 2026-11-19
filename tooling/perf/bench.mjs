// Scan benchmark through the real engine in Chrome: time per stage, model load, memory, main-thread long tasks, and
// (when the subjects' ground truth is at hand) recovery against it. Shared by run.mjs (full report) and ci.mjs (budgets).
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { brotliCompressSync, constants, gzipSync } from "node:zlib"
import { openPage, root } from "../browser/serve.mjs"

export const profiles = {
  desktopCpu: { label: "Desktop, CPU delegate (SwiftShader WebGL)", delegate: "CPU" },
  desktopGpu: { label: "Desktop, GPU delegate (RTX 5070 Ti, real GPU)", delegate: "GPU", gpu: true },
  desktopGpuSoftware: { label: "Desktop, GPU delegate on SwiftShader", delegate: "GPU" },
  phone: {
    label: "Phone emulation: Pixel 7 viewport, 4x CPU throttle, CPU delegate",
    delegate: "CPU",
    cpuThrottle: 4,
    device: "Pixel 7",
  },
}

/** Every file a first scan downloads, with raw, gzip and brotli sizes. */
export function downloadSizes(harnessDir = join(root, ".cache/harness")) {
  const files = [
    ["MediaPipe WASM loader", join(root, "node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_module_internal.js")],
    ["MediaPipe WASM", join(root, "node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_module_internal.wasm")],
    ["Face Landmarker model", join(root, ".cache/models/face_landmarker.task")],
    ["Pose Landmarker full model", join(root, ".cache/models/pose_landmarker_full.task")],
    ["Pose Landmarker lite model (alternative)", join(root, ".cache/models/pose_landmarker_lite.task")],
    ["Anny body model", join(root, "assets/anny/anny.bin")],
  ]
  for (const file of readdirSync(join(harnessDir, "assets")))
    if (file.endsWith(".js"))
      files.push([
        file.startsWith("worker") ? "Engine worker bundle" : "Engine main bundle (with harness)",
        join(harnessDir, "assets", file),
      ])
  return files.map(([name, path]) => {
    const bytes = readFileSync(path)
    return {
      name,
      raw: statSync(path).size,
      gzip: gzipSync(bytes, { level: 9 }).length,
      brotli: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
    }
  })
}

/** Subjects: { id, face: number[], body: number[], truth? } */
export async function runBench(profileName, subjects, options = {}) {
  const profile = profiles[profileName]
  const { devices } = await import("playwright")
  const { browser, page } = await openPage(`${root}/.cache/harness`, "index.html", {
    gpu: profile.gpu ?? false,
    ...(profile.device ? { device: devices[profile.device] } : {}),
    ...(profile.cpuThrottle ? { cpuThrottle: profile.cpuThrottle } : {}),
  })
  try {
    const started = performance.now()
    const ready = await page.evaluate(
      ([delegate, pose]) => globalThis.harness.init(delegate, pose),
      [profile.delegate, options.pose ?? "full"],
    )
    const initWallMs = performance.now() - started
    const scans = []
    await page.evaluate(() => globalThis.harness.resetLongTasks())
    for (const subject of subjects) {
      const result = await page.evaluate(
        ([face, body, height]) => globalThis.harness.scan(face, body, height ?? undefined, true),
        [subject.face, subject.body, options.heightCm ? (subject.truth?.statureCm ?? null) : null],
      )
      const stages = {}
      for (const event of result.events)
        if (event.type === "stage" && event.detail.ms !== undefined)
          stages[event.detail.stage] = (stages[event.detail.stage] ?? 0) + event.detail.ms
      const firstModel = result.events.find((event) => event.type === "model")?.at ?? null
      const progressCount = result.events.filter((event) => event.type === "progress").length
      scans.push({
        id: subject.id,
        totalMs: result.totalMs,
        stages,
        firstModelMs: firstModel,
        progressCount,
        glbBytes: result.glbBytes,
        params: result.params,
        colors: result.colors,
        hair: result.hair,
        quality: result.quality,
      })
    }
    const longTasks = await page.evaluate(() => globalThis.harness.longTasks())
    const memoryBytes = await page.evaluate(() => globalThis.harness.memory()).catch(() => null)
    return {
      profile: profileName,
      label: profile.label,
      delegate: ready.delegate,
      initMs: ready.ms,
      initWallMs,
      scans,
      longTasks,
      memoryBytes,
    }
  } finally {
    await browser.close()
  }
}

export function median(values) {
  const sorted = values.toSorted((a, b) => a - b)
  return sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)]
}

/** Median time per stage across scans. */
export function stageSummary(run) {
  const names = [...new Set(run.scans.flatMap((scan) => Object.keys(scan.stages)))]
  return Object.fromEntries([
    ...names.map((name) => [name, median(run.scans.map((scan) => scan.stages[name] ?? 0))]),
    ["total", median(run.scans.map((scan) => scan.totalMs))],
  ])
}
