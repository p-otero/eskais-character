import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  logLevel: "warn",
  build: {
    outDir: fileURLToPath(new URL("../../../.cache/harness", import.meta.url)),
    emptyOutDir: true,
    assetsInlineLimit: 0,
    target: "es2022",
  },
  worker: { format: "es" },
})
