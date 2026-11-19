// Public types of `eskais-character/scan`: the contract with the UI library.

import type { Phenotype } from "../model/anny.ts"
import type { HairLength } from "../model/hair.ts"

/** sRGB colour as "#rrggbb". */
export type Hex = `#${string}`

export interface ScanInput {
  /** A front photo of the face. */
  face: Blob | ImageBitmap
  /** A full-body front photo (A-pose, fitted clothes). Optional: without it the body stays at the prior. */
  body?: Blob | ImageBitmap
}

export interface ScanHints {
  /** Stature, when the user gives it: photos alone don't carry absolute scale. */
  heightCm?: number
}

export interface ScanOptions {
  signal?: AbortSignal
  hints?: ScanHints
}

export type ScanStage = "load" | "detect-face" | "detect-body" | "fit-body" | "fit-face" | "colors" | "hair" | "export"

export interface CharacterColors {
  skin: Hex
  eyes: Hex
  hair: Hex
  brows: Hex
  /** null when no beard was found. */
  beard: Hex | null
}

export interface HairChoice {
  id: string
  length: HairLength
  /** Every style the user can switch to. */
  options: { id: string; label: string; length: HairLength }[]
}

export interface CharacterParams {
  phenotype: Phenotype
  /** Face modifier values in [-1, 1], by label. */
  face: Record<string, number>
}

export interface Character {
  /** glTF 2.0 binary: skinned body, eyes and hair, with every morph target and the fitted weights as defaults. */
  glb: Uint8Array
  /** Morph target names of the body mesh, as in the GLB's `extras.targetNames`. */
  targetNames: string[]
  /** Fitted morph weights, aligned with `targetNames`. */
  weights: Float32Array
  params: CharacterParams
  colors: CharacterColors
  hair: HairChoice
  quality: { face: number; body: number | null; warnings: string[] }
}

export type ScanEvent =
  /** A stage started (ms omitted) or finished (ms is its duration). */
  | { type: "stage"; stage: ScanStage; ms?: number }
  /** Normalised 2D points (x, y pairs in 0..1) for the UI to light up. */
  | { type: "landmarks"; source: "face" | "body"; points: Float32Array; aspect: number }
  /** The base character: mean shape with every morph target, weights at zero. Sent once, before fitting. */
  | { type: "model"; glb: Uint8Array; targetNames: string[] }
  /** Weights while the fit converges, aligned with the model's `targetNames`; `value` is 0..1 overall progress. */
  | { type: "progress"; value: number; weights: Float32Array }
  | { type: "done"; character: Character }
