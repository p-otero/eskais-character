// MediaPipe Tasks for Web, run in the scan worker. Inputs are ImageBitmaps; outputs are landmarks and a person mask,
// which stay in the worker. Only normalised landmark coordinates are ever posted to the UI.

import { FaceLandmarker, PoseLandmarker } from "@mediapipe/tasks-vision"

/** MediaPipe's WasmFileset, which the package declares but does not export. */
interface WasmFileset {
  wasmLoaderPath: string
  wasmBinaryPath: string
}
import { fetchPinned, pinnedBlobUrl, type AssetUrls } from "./loader.ts"

export type Delegate = "CPU" | "GPU"

export interface FaceDetection {
  /** 478 × (x, y, z), x and y normalised to the image, z in the same scale as x. */
  landmarks: Float32Array
  /** ARKit-named expression scores, 0..1. */
  blendshapes: Record<string, number>
  width: number
  height: number
}

export interface PersonMask {
  width: number
  height: number
  /** Person confidence, 0..255. */
  data: Uint8Array
}

export interface BodyDetection {
  /** 33 × (x, y, z, visibility), x and y normalised to the image. */
  landmarks: Float32Array
  /** 33 × (x, y, z) metres, hip-centred. */
  world: Float32Array
  mask: PersonMask | null
  width: number
  height: number
}

export interface Detectors {
  delegate: Delegate
  detectFace(image: ImageBitmap): FaceDetection | null
  detectBody(image: ImageBitmap): BodyDetection | null
  close(): void
}

export interface DetectorOptions {
  urls: AssetUrls
  delegate: Delegate | "auto"
  poseModel: "lite" | "full"
  signal?: AbortSignal
}

interface Wasm {
  loader: ArrayBuffer
  binaryUrl: string
}

// In a module worker MediaPipe imports its loader with import(), and a module runs once per URL: each task needs its
// own URL for the loader, or the second task finds no ModuleFactory.
function fileset(wasm: Wasm, urls: string[]): WasmFileset {
  const wasmLoaderPath = URL.createObjectURL(new Blob([wasm.loader], { type: "text/javascript" }))
  urls.push(wasmLoaderPath)
  return { wasmLoaderPath, wasmBinaryPath: wasm.binaryUrl }
}

async function create(wasm: Wasm, urls: string[], face: Uint8Array, pose: Uint8Array, delegate: Delegate) {
  const faceLandmarker = await FaceLandmarker.createFromOptions(fileset(wasm, urls), {
    baseOptions: { modelAssetBuffer: face, delegate },
    runningMode: "IMAGE",
    numFaces: 1,
    outputFaceBlendshapes: true,
  })
  try {
    const poseLandmarker = await PoseLandmarker.createFromOptions(fileset(wasm, urls), {
      baseOptions: { modelAssetBuffer: pose, delegate },
      runningMode: "IMAGE",
      numPoses: 1,
      outputSegmentationMasks: true,
    })
    return { faceLandmarker, poseLandmarker }
  } catch (error) {
    faceLandmarker.close()
    throw error
  }
}

export class CapabilityError extends Error {
  override name = "CapabilityError"
}

/**
 * MediaPipe Tasks for Web moves images through WebGL2 even on its CPU delegate (measured with tasks-vision 1.2.3), so
 * a browser without WebGL2 can't scan at all. Chrome falls back to SwiftShader when the GPU is blocklisted, so this is
 * rare; it is reported up front instead of failing inside the first detection.
 */
export function hasWebgl2(): boolean {
  try {
    return new OffscreenCanvas(1, 1).getContext("webgl2") !== null
  } catch {
    return false
  }
}

/**
 * True when WebGL runs on a software rasteriser (SwiftShader, llvmpipe): MediaPipe's GPU delegate is then slower than
 * its CPU delegate, and its first inference compiles shaders for a second or more.
 */
export function softwareWebgl(): boolean {
  try {
    const gl = new OffscreenCanvas(1, 1).getContext("webgl2")
    if (!gl) return false
    const info = gl.getExtension("WEBGL_debug_renderer_info")
    const renderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER))
    return /swiftshader|llvmpipe|software|basic render/i.test(renderer)
  } catch {
    return false
  }
}

export async function createDetectors(options: DetectorOptions): Promise<Detectors> {
  if (!hasWebgl2()) throw new CapabilityError("Scanning needs WebGL2, which this browser does not provide.")
  const { urls, signal } = options
  const [loader, binaryUrl, faceModel, poseModel] = await Promise.all([
    fetchPinned("mediapipeLoader", urls, signal),
    pinnedBlobUrl("mediapipeWasm", urls, "application/wasm", signal),
    fetchPinned("faceLandmarker", urls, signal),
    fetchPinned(options.poseModel === "full" ? "poseLandmarkerFull" : "poseLandmarkerLite", urls, signal),
  ])
  const wasm: Wasm = { loader, binaryUrl }
  const blobUrls = [binaryUrl]
  const revoke = () => {
    for (const url of blobUrls) URL.revokeObjectURL(url)
  }
  const order: Delegate[] =
    options.delegate === "auto" ? (softwareWebgl() ? ["CPU"] : ["GPU", "CPU"]) : [options.delegate]
  let lastError: unknown
  for (const delegate of order) {
    try {
      // MediaPipe takes ownership of the buffers it is given, so each attempt gets its own copy. Attempts are
      // sequential on purpose: the CPU delegate is only tried after the GPU one failed.
      // oxlint-disable-next-line no-await-in-loop -- see above
      const { faceLandmarker, poseLandmarker } = await create(
        wasm,
        blobUrls,
        new Uint8Array(faceModel.slice(0)),
        new Uint8Array(poseModel.slice(0)),
        delegate,
      )
      return {
        delegate,
        detectFace: (image) => readFace(faceLandmarker, image),
        detectBody: (image) => readBody(poseLandmarker, image),
        close() {
          faceLandmarker.close()
          poseLandmarker.close()
          revoke()
        },
      }
    } catch (error) {
      lastError = error
    }
  }
  revoke()
  throw lastError instanceof Error ? lastError : new Error("MediaPipe could not start.")
}

function readFace(landmarker: FaceLandmarker, image: ImageBitmap): FaceDetection | null {
  const result = landmarker.detect(image)
  const points = result.faceLandmarks[0]
  if (!points) return null
  const landmarks = new Float32Array(points.length * 3)
  points.forEach((point, index) => {
    landmarks[index * 3] = point.x
    landmarks[index * 3 + 1] = point.y
    landmarks[index * 3 + 2] = point.z
  })
  const blendshapes: Record<string, number> = {}
  for (const category of result.faceBlendshapes[0]?.categories ?? [])
    blendshapes[category.categoryName] = category.score
  return { landmarks, blendshapes, width: image.width, height: image.height }
}

function readBody(landmarker: PoseLandmarker, image: ImageBitmap): BodyDetection | null {
  const result = landmarker.detect(image)
  const points = result.landmarks[0]
  const worldPoints = result.worldLandmarks[0]
  if (!points || !worldPoints) {
    for (const mask of result.segmentationMasks ?? []) mask.close()
    return null
  }
  const landmarks = new Float32Array(points.length * 4)
  points.forEach((point, index) => {
    landmarks.set([point.x, point.y, point.z, point.visibility], index * 4)
  })
  const world = new Float32Array(worldPoints.length * 3)
  worldPoints.forEach((point, index) => {
    world.set([point.x, point.y, point.z], index * 3)
  })
  let mask: PersonMask | null = null
  const source = result.segmentationMasks?.[0]
  if (source) {
    const values = source.getAsFloat32Array()
    const data = new Uint8Array(values.length)
    for (let index = 0; index < values.length; index++) data[index] = Math.round((values[index] ?? 0) * 255)
    mask = { width: source.width, height: source.height, data }
  }
  for (const each of result.segmentationMasks ?? []) each.close()
  return { landmarks, world, mask, width: image.width, height: image.height }
}
