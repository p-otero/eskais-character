import { build } from "vite"
export async function buildHarness() {
  await build({
    configFile: new URL("./harness/vite.config.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
  })
}
if (import.meta.url === `file:///${process.argv[1]?.replaceAll("\\", "/")}`) await buildHarness()
