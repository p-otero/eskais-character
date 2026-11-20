// Library build into a flat dist/: public entries without MediaPipe (react and three stay external), and one
// self-contained worker that works whether a bundler processes it or only copies it. Source paths are rewritten to
// dist paths: `./worker.ts` becomes `./worker.js`, and the package's assets sit one level up instead of two.
import { MagicString } from "magic-string"
import { defineConfig, type UserConfig } from "tsdown"

const distPaths = {
  name: "eskais-dist-paths",
  transform(code: string, id: string) {
    if (!/[\\/]src[\\/]/.test(id)) return null
    if (!code.includes("import.meta.url")) return null
    const out = new MagicString(code)
    out.replaceAll('"./worker.ts"', '"./worker.js"').replaceAll('"../../assets/', '"../assets/')
    return { code: out.toString(), map: out.generateMap({ hires: true, source: id }) }
  },
}

const shared: UserConfig = {
  format: "esm",
  platform: "browser",
  target: "es2022",
  outDir: "dist",
  fixedExtension: false,
  hash: false,
  sourcemap: true,
  plugins: [distPaths],
  tsconfig: "tsconfig.runtime.json",
}

export default defineConfig([
  {
    ...shared,
    entry: {
      index: "src/scan/index.ts",
      react: "src/react/index.ts",
      three: "src/three/index.ts",
      motion: "src/motion/index.ts",
    },
    clean: true,
    dts: true,
    deps: { neverBundle: ["react", "three", /^three\//, "@mediapipe/tasks-vision"] },
  },
  {
    ...shared,
    entry: { worker: "src/scan/worker.ts" },
    clean: false,
    dts: false,
    copy: [{ from: "tooling/package/worker.d.ts", to: "dist" }],
    minify: true,
    deps: { alwaysBundle: ["@mediapipe/tasks-vision"], onlyBundle: ["@mediapipe/tasks-vision"] },
  },
])
