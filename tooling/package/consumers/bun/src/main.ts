import { createScanEngine, type ScanEvent } from "eskais-character"
const out = document.getElementById("out")!
const log: string[] = []
const engine = createScanEngine({ delegate: "CPU", workerUrl: "/worker.js" })
;(async () => {
  const ready = await engine.ready
  log.push(`ready ${ready.delegate}`)
  const face = await (await fetch("/s001-face.png")).blob()
  const body = await (await fetch("/s001-body.png")).blob()
  const types: string[] = []
  let done: Extract<ScanEvent, { type: "done" }> | undefined
  for await (const event of engine.scan({ face, body })) {
    types.push(event.type)
    if (event.type === "done") done = event
    if (event.type === "error") log.push(`error ${event.error.code}`)
  }
  log.push(
    `events ${types.length} last ${types.at(-1)} glb ${done?.character.glb.byteLength ?? 0} hair ${done?.character.hair.id}`,
  )
  const restyled = done && (await engine.restyle(done.character, { style: "cel-outline" }))
  log.push(`restyle ${restyled?.look.style}`)
  out.textContent = "DONE " + log.join(" | ")
})().catch((e) => (out.textContent = "FAIL " + String(e)))
