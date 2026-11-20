// The package's own model files, as URLs the host's bundler can see: `new URL("…", import.meta.url)` in code that runs
// on the main thread makes Vite, webpack, Next and bun emit the files and rewrite the URLs. The worker gets them at
// init, so it never has to resolve paths itself.
import type { AssetUrls } from "./loader.ts"

export function bundledAssetUrls(): AssetUrls {
  return {
    annyModel: new URL("../../assets/anny/anny.bin", import.meta.url).href,
    hairModel: new URL("../../assets/hair/hair.bin", import.meta.url).href,
  }
}
