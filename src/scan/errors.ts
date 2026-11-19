// Scan failures as stable codes, so the UI can react without parsing messages. Classes don't survive postMessage, so
// the worker sends the code and the main thread rebuilds a ScanError.

import { CapabilityError } from "./detect.ts"
import { AssetIntegrityError, AssetLoadError } from "./loader.ts"

export const scanErrorCodes = [
  /** No face in the face photo. */
  "no-face",
  /** A photo couldn't be decoded. */
  "unreadable-image",
  /** The browser lacks WebGL2, which MediaPipe needs even on its CPU delegate. */
  "webgl2-unavailable",
  /** A downloaded model or asset didn't match its pinned size or SHA-256. */
  "asset-integrity",
  /** A model or asset couldn't be downloaded. */
  "asset-load",
  /** The worker crashed or couldn't start. */
  "worker",
  "internal",
] as const
export type ScanErrorCode = (typeof scanErrorCodes)[number]

export class ScanError extends Error {
  override name = "ScanError"
  constructor(
    readonly code: ScanErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export function errorCode(error: unknown): ScanErrorCode {
  if (error instanceof ScanError) return error.code
  if (error instanceof CapabilityError) return "webgl2-unavailable"
  if (error instanceof AssetIntegrityError) return "asset-integrity"
  if (error instanceof AssetLoadError) return "asset-load"
  return "internal"
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The scan failed."
}
