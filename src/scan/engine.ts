// Main-thread side: owns the worker and turns its messages into an async event stream. Nothing heavy runs here, so a
// scan never blocks the UI thread.

import type { Delegate } from "./detect.ts"
import { errorCode, errorMessage, ScanError } from "./errors.ts"
import type { AssetUrls } from "./loader.ts"
import type { WorkerRequest, WorkerResponse } from "./protocol.ts"
import type { ScanEvent, ScanInput, ScanOptions } from "./types.ts"

export interface ScanEngineOptions {
  /** Where to load each pinned asset from, when the host serves its own copies (same bytes, same SHA-256). */
  assetUrls?: AssetUrls
  /** MediaPipe delegate: "auto" tries the GPU and falls back to the CPU. */
  delegate?: Delegate | "auto"
  /** Pose model: "lite" (5.8 MB) or "full" (9.4 MB, more accurate). */
  poseModel?: "lite" | "full"
  /** Creates the worker; the default bundles src/scan/worker.ts. */
  createWorker?: () => Worker
}

export interface ScanEngine {
  /**
   * Resolves when the models are loaded; `delegate` says whether MediaPipe got the GPU. Rejects with a ScanError
   * (code "webgl2-unavailable", "asset-load", "asset-integrity" or "worker"); `scan()` then yields that error event.
   */
  ready: Promise<{ delegate: Delegate; ms: number }>
  scan(input: ScanInput, options?: ScanOptions): AsyncGenerator<ScanEvent, void, undefined>
  /** Test hook: landmarks of one image, without a scan. */
  detect(kind: "face" | "body", image: Blob | ImageBitmap): Promise<Extract<WorkerResponse, { type: "detected" }>>
  dispose(): void
}

function defaultWorker(): Worker {
  return new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "eskais-character-scan" })
}

function failure(error: unknown): Extract<ScanEvent, { type: "error" }> {
  return { type: "error", error: { code: errorCode(error), message: errorMessage(error) } }
}

async function toBitmap(source: Blob | ImageBitmap): Promise<ImageBitmap> {
  // A copy, so transferring it to the worker never detaches the caller's bitmap.
  return createImageBitmap(source)
}

export function createScanEngine(options: ScanEngineOptions = {}): ScanEngine {
  const worker = (options.createWorker ?? defaultWorker)()
  let nextId = 1
  const listeners = new Map<number, (message: WorkerResponse) => void>()
  const {
    promise: ready,
    resolve: resolveReady,
    reject: rejectReady,
  } = Promise.withResolvers<{ delegate: Delegate; ms: number }>()
  worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
    const message = event.data
    if (message.type === "ready") resolveReady({ delegate: message.delegate, ms: message.ms })
    else if (message.type === "init-error") rejectReady(new ScanError(message.code, message.message))
    else listeners.get(message.id)?.(message)
  })
  worker.addEventListener("error", (event) => {
    const message = event.message || "The scan worker failed."
    rejectReady(new ScanError("worker", message))
    // A crash mid-scan ends every scan in flight with an error event.
    for (const [id, listener] of listeners) listener({ type: "error", id, code: "worker", message })
  })
  const send = (request: WorkerRequest, transfer: Transferable[] = []) => worker.postMessage(request, transfer)
  send({
    type: "init",
    urls: options.assetUrls ?? {},
    delegate: options.delegate ?? "auto",
    poseModel: options.poseModel ?? "full",
  })

  async function* scan(input: ScanInput, scanOptions: ScanOptions = {}): AsyncGenerator<ScanEvent, void, undefined> {
    const { signal } = scanOptions
    signal?.throwIfAborted()
    try {
      await ready
    } catch (error) {
      yield failure(error)
      return
    }
    const id = nextId++
    const queue: WorkerResponse[] = []
    let wake: (() => void) | undefined
    listeners.set(id, (message) => {
      queue.push(message)
      wake?.()
    })
    const abort = () => send({ type: "cancel", id })
    signal?.addEventListener("abort", abort, { once: true })
    try {
      let face: ImageBitmap
      let body: ImageBitmap | null
      try {
        face = await toBitmap(input.face)
        body = input.body ? await toBitmap(input.body) : null
      } catch {
        yield { type: "error", error: { code: "unreadable-image", message: "A photo could not be decoded." } }
        return
      }
      send({ type: "scan", id, face, body, hints: scanOptions.hints ?? {} }, body ? [face, body] : [face])
      for (;;) {
        while (queue.length === 0) {
          signal?.throwIfAborted()
          // oxlint-disable-next-line no-await-in-loop -- events arrive one at a time; each wait is for the next one
          await new Promise<void>((resolve) => {
            wake = resolve
            signal?.addEventListener("abort", () => resolve(), { once: true })
          })
          wake = undefined
        }
        signal?.throwIfAborted()
        const message = queue.shift()
        if (!message) continue
        if (message.type === "event") yield message.event
        else if (message.type === "end") return
        else if (message.type === "error") {
          yield { type: "error", error: { code: message.code, message: message.message } }
          return
        }
      }
    } finally {
      signal?.removeEventListener("abort", abort)
      listeners.delete(id)
    }
  }

  return {
    ready,
    scan,
    async detect(kind, image) {
      await ready
      const id = nextId++
      const bitmap = await toBitmap(image)
      return new Promise((resolve, reject) => {
        listeners.set(id, (message) => {
          listeners.delete(id)
          if (message.type === "detected") resolve(message)
          else if (message.type === "error") reject(new ScanError(message.code, message.message))
        })
        send({ type: "detect", id, kind, image: bitmap }, [bitmap])
      })
    },
    dispose() {
      worker.terminate()
      listeners.clear()
    },
  }
}
