// The look options and their defaults; kept apart from the exporter so the main thread can use them cheaply.
import type { CharacterLook, LookOptions } from "./types.ts"

export const defaultLook: CharacterLook = { style: "soft-toon", stylize: 0.5, outfit: "casual" }

export function resolveLook(options: LookOptions | undefined, base: CharacterLook = defaultLook): CharacterLook {
  return {
    style: options?.style ?? base.style,
    stylize: Math.min(Math.max(options?.stylize ?? base.stylize, 0), 1),
    outfit: options?.outfit ?? base.outfit,
  }
}
