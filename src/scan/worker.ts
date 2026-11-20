// The scan worker: MediaPipe, fitting, colour sampling and GLB export all run here, off the main thread. Input bitmaps
// are closed as soon as their stage is done; nothing derived from pixels leaves except landmarks and the character.

import { createDetectors, type Detectors } from "./detect.ts"
import { errorCode, errorMessage } from "./errors.ts"
import { exportCharacter } from "./export.ts"
import type { AssetUrls } from "./loader.ts"
import type { WorkerRequest, WorkerResponse } from "./protocol.ts"
import { measureBody } from "./measure-body.ts"
import { loadHairAsset } from "./hair-asset.ts"
import { loadModel, runScan } from "./pipeline.ts"

interface WorkerScope {
  addEventListener(type: "message", listener: (event: MessageEvent<WorkerRequest>) => void): void
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void
}

const scope = globalThis as unknown as WorkerScope
let detectors: Promise<Detectors> | undefined
let urls: AssetUrls = {}
const cancelled = new Set<number>()

function post(message: WorkerResponse, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer)
}

scope.addEventListener("message", (message) => {
  const request = message.data
  switch (request.type) {
    case "init": {
      const started = performance.now()
      urls = request.urls
      detectors = createDetectors({ urls, delegate: request.delegate, poseModel: request.poseModel })
      // Everything a scan needs is downloaded here, so the scan itself never touches the network.
      Promise.all([detectors, loadModel(urls), loadHairAsset(urls)]).then(
        ([ready]) => post({ type: "ready", delegate: ready.delegate, ms: performance.now() - started }),
        (error: unknown) => post({ type: "init-error", code: errorCode(error), message: errorMessage(error) }),
      )
      return
    }
    case "cancel":
      cancelled.add(request.id)
      return
    case "detect": {
      void (async () => {
        const ready = await detectors
        if (!ready) throw new Error("The worker was not initialised.")
        const started = performance.now()
        const face = request.kind === "face" ? ready.detectFace(request.image) : null
        const body = request.kind === "body" ? ready.detectBody(request.image) : null
        request.image.close()
        const ms = performance.now() - started
        const landmarks = face?.landmarks ?? body?.landmarks ?? null
        const features = body?.mask
          ? (measureBody(body.landmarks, body.mask, body.width, body.height)?.features ?? null)
          : null
        post(
          { type: "detected", id: request.id, landmarks, blendshapes: face?.blendshapes ?? null, features, ms },
          landmarks ? [landmarks.buffer] : [],
        )
      })().catch((error: unknown) => {
        post({ type: "error", id: request.id, code: errorCode(error), message: errorMessage(error) })
      })
      return
    }
    case "restyle": {
      void loadModel(urls)
        .then((model) => {
          const character = exportCharacter(model, request.input)
          post({ type: "restyled", id: request.id, character }, [character.glb.buffer])
        })
        .catch((error: unknown) => {
          post({ type: "error", id: request.id, code: errorCode(error), message: errorMessage(error) })
        })
      return
    }
    case "scan": {
      void (async () => {
        const ready = await detectors
        if (!ready) throw new Error("The worker was not initialised.")
        await runScan(
          ready,
          request,
          {
            emit: (event, transfer) => post({ type: "event", id: request.id, event }, transfer),
            cancelled: () => cancelled.has(request.id),
          },
          urls,
        )
        post({ type: "end", id: request.id })
      })()
        .catch((error: unknown) => {
          post({ type: "error", id: request.id, code: errorCode(error), message: errorMessage(error) })
        })
        .finally(() => {
          request.face.close()
          request.body?.close()
          cancelled.delete(request.id)
        })
      return
    }
  }
})
