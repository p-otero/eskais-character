"use client"
import { useEffect, useState } from "react"
import { createScanEngine, type ScanEvent } from "eskais-character"

export default function Page() {
  const [text, setText] = useState("starting")
  useEffect(() => {
    const engine = createScanEngine({ delegate: "CPU" })
    const log: string[] = []
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
      }
      log.push(`events ${types.length} last ${types.at(-1)} glb ${done?.character.glb.byteLength ?? 0}`)
      const restyled = done && (await engine.restyle(done.character, { style: "clay" }))
      log.push(`restyle ${restyled?.look.style}`)
      setText("DONE " + log.join(" | "))
    })().catch((e) => setText("FAIL " + String(e)))
    return () => engine.dispose()
  }, [])
  return <pre id="out">{text}</pre>
}
