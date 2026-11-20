// Runs the engine's worker detection on PNG bytes in headless Chrome (tooling only).
import { buildHarness } from "./build-harness.mjs"
import { openPage, root } from "./serve.mjs"

export interface Detector {
  detect(
    kind: "face" | "body",
    png: Uint8Array,
  ): Promise<{
    landmarks: number[] | null
    blendshapes: Record<string, number> | null
    features: Record<string, number> | null
    ms: number
  }>
  page: import("playwright").Page
  close(): Promise<void>
}

export async function startDetector(
  options: { build?: boolean; delegate?: "CPU" | "GPU" | "auto"; pose?: "lite" | "full"; gpu?: boolean } = {},
): Promise<Detector> {
  if (options.build !== false) await buildHarness()
  const { browser, page } = await openPage(`${root}/.cache/harness`, "index.html", { gpu: options.gpu ?? false })
  await page.evaluate(
    ([delegate, pose]) =>
      (globalThis as never as { harness: { init(a: string, b: string): Promise<unknown> } }).harness.init(
        delegate!,
        pose!,
      ),
    [options.delegate ?? "CPU", options.pose ?? "full"],
  )
  return {
    page,
    detect: (kind, png) =>
      page.evaluate(
        ([k, bytes]) =>
          (globalThis as never as { harness: { detect(a: unknown, b: unknown): Promise<never> } }).harness.detect(
            k,
            bytes,
          ),
        [kind, Array.from(png)] as const,
      ),
    close: () => browser.close(),
  }
}
