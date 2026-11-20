// Every file the engine may download, pinned by URL, size and SHA-256. The loader refuses anything else, and these
// are the only network requests the engine makes.

import { packageVersion } from "../version.ts"

export interface PinnedAsset {
  /** Default location; the host may serve the same bytes from elsewhere (see ScanEngineOptions.assetUrls). */
  url: string
  sha256: string
  bytes: number
  licence: string
}

export const assetIds = [
  "mediapipeLoader",
  "mediapipeWasm",
  "mediapipeLoaderClassic",
  "mediapipeWasmClassic",
  "faceLandmarker",
  "poseLandmarkerLite",
  "poseLandmarkerFull",
  "annyModel",
  "hairModel",
] as const
export type AssetId = (typeof assetIds)[number]

const mediapipe = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/wasm"
const models = "https://storage.googleapis.com/mediapipe-models"
// The package's own assets, from the published package on the CDN. Only a fallback: the engine resolves the copies the
// host's bundler emits (src/scan/asset-urls.ts) and uses those first.
const ownAssets = `https://cdn.jsdelivr.net/npm/eskais-character@${packageVersion}/assets`

export const pinnedAssets: Record<AssetId, PinnedAsset> = {
  mediapipeLoader: {
    url: `${mediapipe}/vision_wasm_module_internal.js`,
    sha256: "d29996249490361715c769c6a49b43ad47e6ac9a28a8e8bce8d02b238e897851",
    bytes: 336_662,
    licence: "Apache-2.0",
  },
  mediapipeWasm: {
    url: `${mediapipe}/vision_wasm_module_internal.wasm`,
    sha256: "a269e84b12aefc93c9d6a4d62b01f41e5434a9fa941533bb8e75b1e3d1669e46",
    bytes: 14_665_738,
    licence: "Apache-2.0",
  },
  // MediaPipe's loader for classic workers (Next's Turbopack starts workers that way), and its matching WASM.
  mediapipeLoaderClassic: {
    url: `${mediapipe}/vision_wasm_internal.js`,
    sha256: "2aa5fd3fdd3d8208cd7587df0bb19fb6925c4ea16a76dd025aedc1f64d6a6309",
    bytes: 336_624,
    licence: "Apache-2.0",
  },
  mediapipeWasmClassic: {
    url: `${mediapipe}/vision_wasm_internal.wasm`,
    sha256: "225bc06c0f51a9cf31fea0e9e0b0243e9e01fb5ef332cc1a7fa6656dbdfdaabf",
    bytes: 14_665_716,
    licence: "Apache-2.0",
  },
  faceLandmarker: {
    url: `${models}/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
    sha256: "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff",
    bytes: 3_758_596,
    licence: "Apache-2.0",
  },
  poseLandmarkerLite: {
    url: `${models}/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`,
    sha256: "59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a",
    bytes: 5_777_746,
    licence: "Apache-2.0",
  },
  poseLandmarkerFull: {
    url: `${models}/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task`,
    sha256: "5134a3aad27a58b93da0088d431f366da362b44e3ccfbe3462b3827a839011b1",
    bytes: 9_398_198,
    licence: "Apache-2.0",
  },
  annyModel: {
    url: `${ownAssets}/anny/anny.bin`,
    sha256: "d7dc924fdcc30dd9d77aa9edad14339d2cdfaa3426e87e052a7907a1e00f0cd8",
    bytes: 5_176_480,
    licence: "Apache-2.0 AND CC0-1.0",
  },
  hairModel: {
    url: `${ownAssets}/hair/hair.bin`,
    sha256: "5f0fc166c7a13c949cd047701c493ff2d6db70d8a7a6cd4258e24a28e6997e22",
    bytes: 370_408,
    licence: "CC0-1.0",
  },
}
