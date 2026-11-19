// Picks a style from the catalogue by the hair's visible shape in the face photo. Thresholds were set on synthetic
// people (tooling/calibrate/colors.ts); `fall` and `crown` are in face heights (eyes to chin). The face photo is cropped
// at the shoulders, so anything falling past about 1.3 face heights reads as long.
import type { FaceColors } from "./colors.ts"

export const hairThresholds = { coverage: 0.3, long: 1.3, medium: 0.6, short: 0.05 }

export function pickHair(colors: Pick<FaceColors, "hair" | "hairShape">, thresholds = hairThresholds): string {
  const { coverage, fall } = colors.hairShape
  if (!colors.hair || coverage < thresholds.coverage) return "none"
  if (fall >= thresholds.long) return "long"
  if (fall >= thresholds.medium) return "medium"
  return fall >= thresholds.short ? "short" : "buzz"
}
