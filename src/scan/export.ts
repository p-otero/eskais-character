// Turns fitted parameters, colours and a look into the public Character: used at the end of a scan and by restyle,
// which re-exports without the photo (it only needs what the Character already carries).

import { bodyCoefficients, type AnnyModel } from "../model/anny.ts"
import { writeCharacterGlb, type CharacterColors as GlbColors, type Rgb } from "../model/glb.ts"
import { hairCatalogue, hairStyle } from "../model/hair.ts"
import { outfitIds } from "../model/outfit.ts"
import { stylePreset, stylePresets, styleIds } from "../model/style.ts"
import { hex } from "./colors.ts"
import type { Character, CharacterColors, CharacterLook, CharacterParams, Hex } from "./types.ts"

function rgb(value: Hex): Rgb {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value)
  if (!match) throw new Error(`"${value}" is not a #rrggbb colour.`)
  return [
    Number.parseInt(match[1] ?? "0", 16),
    Number.parseInt(match[2] ?? "0", 16),
    Number.parseInt(match[3] ?? "0", 16),
  ]
}

export interface ExportInput {
  params: CharacterParams
  colors: CharacterColors
  hairId: string
  look: CharacterLook
  quality: Character["quality"]
}

export function exportCharacter(model: AnnyModel, input: ExportInput): Character {
  const { params, colors, look } = input
  const hair = hairStyle(input.hairId)
  stylePreset(look.style)
  const glbColors: GlbColors = {
    skin: rgb(colors.skin),
    eyes: rgb(colors.eyes),
    hair: rgb(colors.hair),
    brows: rgb(colors.brows),
    beard: colors.beard ? rgb(colors.beard) : null,
  }
  const face = model.faceModifierLabels.map((label) => params.face[label] ?? 0)
  const result = writeCharacterGlb({
    model,
    body: bodyCoefficients(model, params.phenotype),
    face,
    colors: glbColors,
    hair,
    look: { style: stylePresets[look.style], stylize: look.stylize, outfit: look.outfit },
    mode: "character",
  })
  return {
    glb: result.glb,
    targetNames: result.targetNames,
    weights: result.weights,
    params,
    colors: {
      skin: hex(glbColors.skin),
      eyes: hex(glbColors.eyes),
      hair: hex(glbColors.hair),
      brows: hex(glbColors.brows),
      beard: glbColors.beard ? hex(glbColors.beard) : null,
    },
    hair: {
      id: hair.id,
      length: hair.length,
      options: hairCatalogue.map(({ id, label, length }) => ({ id, label, length })),
    },
    look: {
      ...look,
      styles: styleIds.map((id) => ({ id, label: stylePresets[id].label })),
      // The underwear-fitted body stays internal: "none" is accepted but not offered.
      outfits: outfitIds.filter((id) => id !== "none"),
    },
    quality: input.quality,
  }
}
