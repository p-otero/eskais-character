export { pinnedAssets, assetIds } from "./assets.ts"
export type { AssetId, PinnedAsset } from "./assets.ts"
export { createScanEngine } from "./engine.ts"
export type { ScanEngine, ScanEngineOptions } from "./engine.ts"
export { AssetIntegrityError } from "./loader.ts"
export type { AssetUrls } from "./loader.ts"
export { CapabilityError } from "./detect.ts"
export type { Delegate } from "./detect.ts"
export type {
  Character,
  CharacterColors,
  CharacterParams,
  HairChoice,
  Hex,
  ScanEvent,
  ScanHints,
  ScanInput,
  ScanOptions,
  ScanStage,
} from "./types.ts"
export { hairCatalogue } from "../model/hair.ts"
export type { HairStyle, HairLength } from "../model/hair.ts"

import type { ScanEngine, ScanEngineOptions } from "./engine.ts"
import { createScanEngine } from "./engine.ts"
import type { ScanEvent, ScanInput, ScanOptions } from "./types.ts"

let shared: ScanEngine | undefined

/** One-call form of the contract: `for await (const e of scanCharacter({ face, body }, { signal }))`. */
export function scanCharacter(
  input: ScanInput,
  options: ScanOptions & { engine?: ScanEngineOptions } = {},
): AsyncGenerator<ScanEvent, void, undefined> {
  shared ??= createScanEngine(options.engine)
  const { engine: _engine, ...scanOptions } = options
  return shared.scan(input, scanOptions)
}
