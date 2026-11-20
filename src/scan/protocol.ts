// Messages between the main thread and the scan worker. Images cross once, as transferred ImageBitmaps, towards the
// worker; nothing derived from pixels comes back except normalised landmark coordinates and the character.

import type { Delegate } from "./detect.ts"
import type { AssetUrls } from "./loader.ts"
import type { ScanErrorCode } from "./errors.ts"
import type { BodyFeatures } from "./measure-body.ts"
import type { ExportInput } from "./export.ts"
import type { Character, LookOptions, ScanEvent, ScanHints } from "./types.ts"

export interface InitRequest {
  type: "init"
  urls: AssetUrls
  delegate: Delegate | "auto"
  poseModel: "lite" | "full"
}

export interface ScanRequest {
  type: "scan"
  id: number
  face: ImageBitmap
  body: ImageBitmap | null
  hints: ScanHints
  look: LookOptions
}

export interface RestyleRequest {
  type: "restyle"
  id: number
  input: ExportInput
}

export interface CancelRequest {
  type: "cancel"
  id: number
}

export interface DetectRequest {
  type: "detect"
  id: number
  kind: "face" | "body"
  image: ImageBitmap
}

export type WorkerRequest = InitRequest | ScanRequest | CancelRequest | DetectRequest | RestyleRequest

export type WorkerResponse =
  | { type: "ready"; delegate: Delegate; ms: number }
  | { type: "init-error"; code: ScanErrorCode; message: string }
  | { type: "event"; id: number; event: ScanEvent }
  | { type: "end"; id: number }
  | { type: "restyled"; id: number; character: Character }
  | { type: "error"; id: number; code: ScanErrorCode; message: string }
  | {
      type: "detected"
      id: number
      landmarks: Float32Array | null
      blendshapes: Record<string, number> | null
      features: BodyFeatures | null
      ms: number
    }
