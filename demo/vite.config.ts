import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  publicDir: false,
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
    assetsInlineLimit: 0,
    target: "es2022",
  },
  worker: { format: "es" },
  server: { fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] } },
})
