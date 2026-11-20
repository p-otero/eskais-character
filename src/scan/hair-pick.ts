// Picks a style from the catalogue by the hair's visible shape in the face photo. Thresholds were set on synthetic
// people (tooling/calibrate/colors.ts); `fall` and `crown` are in face heights (eyes to chin). The face photo is cropped
// at the shoulders, so anything falling past about 1.3 face heights reads as long.
import type { HairLength } from "../model/hair.ts"
import type { FaceColors } from "./colors.ts"

// Fitted by tooling/calibrate/hair-thresholds.ts on seed 4000 (37% on it, 46% held out over five classes): the MakeHuman
// hair mostly falls behind the shoulders, out of a front face crop, so length is a weak signal here.
export const hairThresholds = { coverage: 0.15, long: 1, medium: 0.3, short: 0.02 }

/** The catalogue style each detected length starts from; the user can switch to any other. */
export const defaultStyleByLength: Record<HairLength, string> = {
  none: "none",
  buzz: "buzz",
  short: "crop",
  medium: "fringe-bob",
  long: "long",
}

export function pickHairLength(
  colors: Pick<FaceColors, "hair" | "hairShape">,
  thresholds = hairThresholds,
): HairLength {
  const { coverage, fall } = colors.hairShape
  if (!colors.hair || coverage < thresholds.coverage) return "none"
  if (fall >= thresholds.long) return "long"
  if (fall >= thresholds.medium) return "medium"
  return fall >= thresholds.short ? "short" : "buzz"
}

/** A catalogue id for the photo's hair. */
export function pickHair(colors: Pick<FaceColors, "hair" | "hairShape">, thresholds = hairThresholds): string {
  return defaultStyleByLength[pickHairLength(colors, thresholds)]
}
