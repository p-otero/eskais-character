// Loads the pinned hair asset (CC0 MakeHuman hair, fitted per character) and registers it for buildHair.
import manifest from "../../assets/hair/hair.json" with { type: "json" }
import { parseHairAsset, registerHairAsset, type HairAsset, type HairManifest } from "../model/hair.ts"
import { fetchPinned, type AssetUrls } from "./loader.ts"

let hairPromise: Promise<HairAsset> | undefined

export function loadHairAsset(urls: AssetUrls, signal?: AbortSignal): Promise<HairAsset> {
  hairPromise ??= fetchPinned("hairModel", urls, signal).then((buffer) => {
    const asset = parseHairAsset(buffer, manifest as unknown as HairManifest)
    registerHairAsset(asset)
    return asset
  })
  return hairPromise
}
