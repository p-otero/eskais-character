// Hair catalogue: CC0 MakeHuman hair (assets/hair, baked by tooling/bake/hair) fitted to the character's own head, so
// each style follows any fitted or stylised shape. Every vertex is three anchor vertices of Anny's head, neck or upper
// back, with barycentric weights, plus an offset scaled by the head's size (MakeHuman's proxy fitting). Until the
// asset is registered, a style falls back to a plain shell over the painted scalp.

import { Region, type HeadFrame } from "./regions.ts"

export type HairLength = "none" | "buzz" | "short" | "medium" | "long"
export type HairShape = "none" | "painted" | "straight" | "wavy" | "updo" | "braid" | "afro"

export interface HairStyle {
  id: string
  label: string
  length: HairLength
  shape: HairShape
  /** Shell thickness for the fallback, metres; 0 for no geometry. */
  thickness: number
  /** Asset style with the fitted geometry; null for no mesh ("none", the painted "buzz"). */
  asset: string | null
}

export const hairCatalogue: readonly HairStyle[] = [
  { id: "none", label: "No hair", length: "none", shape: "none", thickness: 0, asset: null },
  { id: "buzz", label: "Buzz cut", length: "buzz", shape: "painted", thickness: 0, asset: null },
  { id: "crop", label: "Short crop", length: "short", shape: "straight", thickness: 0.007, asset: "crop" },
  { id: "side-part", label: "Side part", length: "short", shape: "straight", thickness: 0.008, asset: "side-part" },
  { id: "afro", label: "Short afro", length: "short", shape: "afro", thickness: 0.015, asset: "afro" },
  { id: "bob", label: "Bob", length: "medium", shape: "straight", thickness: 0.01, asset: "bob" },
  {
    id: "fringe-bob",
    label: "Bob with fringe",
    length: "medium",
    shape: "straight",
    thickness: 0.01,
    asset: "fringe-bob",
  },
  { id: "long", label: "Long straight", length: "long", shape: "straight", thickness: 0.012, asset: "long" },
  { id: "ponytail", label: "Ponytail", length: "long", shape: "updo", thickness: 0.01, asset: "ponytail" },
  { id: "braid", label: "Braid", length: "long", shape: "braid", thickness: 0.01, asset: "braid" },
]

/** Ids of the procedural placeholder catalogue, kept resolvable for older manifests and fixtures. */
const legacyIds: Record<string, string> = { short: "crop", medium: "bob" }

export function hairStyle(id: string): HairStyle {
  const style = hairCatalogue.find((candidate) => candidate.id === (legacyIds[id] ?? id))
  if (!style) throw new Error(`Unknown hair style "${id}".`)
  return style
}

interface LayoutEntry {
  offset: number
  dtype: "uint8" | "uint16" | "int16"
  shape: number[]
}

export interface HairManifest {
  format: "eskais-hair/2"
  sha256: string
  byteLength: number
  /** Head-size references per axis: two Anny vertices and their distance on the template, metres. */
  scale: Record<"x" | "y" | "z", [number, number, number]>
  anchorFaces: LayoutEntry
  styles: {
    id: string
    offsetStep: number
    vertexCount: number
    triangleCount: number
    layout: Record<"anchorTriangles" | "weights" | "offsets" | "shade" | "triangles", LayoutEntry>
  }[]
}

interface AssetStyle {
  anchorTriangles: Uint16Array
  weights: Uint8Array
  offsets: Int16Array
  offsetStep: number
  shade: Uint8Array
  triangles: Uint16Array
}

export interface HairAsset {
  manifest: HairManifest
  anchorFaces: Uint16Array
  styles: Map<string, AssetStyle>
}

function view<T extends Uint8Array | Uint16Array>(
  buffer: ArrayBuffer,
  entry: LayoutEntry,
  Kind: new (buffer: ArrayBuffer, offset: number, length: number) => T,
): T {
  return new Kind(
    buffer,
    entry.offset,
    entry.shape.reduce((product, size) => product * size, 1),
  )
}

/** Undoes the bake's storage: byte planes (low bytes, then high bytes), then per-column deltas with a 16-bit wrap. */
function decode16<T extends Uint16Array | Int16Array>(
  buffer: ArrayBuffer,
  entry: LayoutEntry,
  Kind: new (length: number) => T,
): T {
  const count = entry.shape.reduce((product, size) => product * size, 1)
  const columns = entry.shape.length > 1 ? (entry.shape[entry.shape.length - 1] ?? 1) : 1
  const bytes = new Uint8Array(buffer, entry.offset, count * 2)
  const out = new Kind(count)
  const running = new Uint16Array(columns)
  for (let index = 0; index < count; index++) {
    const column = index % columns
    const value = ((bytes[index] ?? 0) | ((bytes[count + index] ?? 0) << 8)) & 0xffff
    running[column] = ((running[column] ?? 0) + value) & 0xffff
    out[index] = running[column] ?? 0
  }
  return out
}

export function parseHairAsset(buffer: ArrayBuffer, manifest: HairManifest): HairAsset {
  if (manifest.format !== "eskais-hair/2") throw new Error(`Unknown hair asset format "${String(manifest.format)}".`)
  if (buffer.byteLength !== manifest.byteLength)
    throw new Error(
      `The hair asset is ${String(buffer.byteLength)} bytes; the manifest says ${String(manifest.byteLength)}.`,
    )
  const styles = new Map<string, AssetStyle>()
  for (const style of manifest.styles)
    styles.set(style.id, {
      anchorTriangles: decode16(buffer, style.layout.anchorTriangles, Uint16Array),
      weights: view(buffer, style.layout.weights, Uint8Array),
      offsets: decode16(buffer, style.layout.offsets, Int16Array),
      offsetStep: style.offsetStep,
      shade: view(buffer, style.layout.shade, Uint8Array),
      triangles: decode16(
        buffer,
        { ...style.layout.triangles, shape: [style.layout.triangles.shape.reduce((a, b) => a * b, 1)] },
        Uint16Array,
      ),
    })
  return { manifest, anchorFaces: view(buffer, manifest.anchorFaces, Uint16Array), styles }
}

let registered: HairAsset | null = null

/** Makes buildHair use the fitted CC0 geometry. Call once after loading the asset (the worker does, at init). */
export function registerHairAsset(asset: HairAsset | null): void {
  registered = asset
}

export interface HairMesh {
  positions: Float32Array
  indices: Uint32Array
  /** Per-vertex shade from the source texture's strand brightness, about 0.55..1; multiply into the hair colour. */
  shade?: Float32Array
  /** Per vertex, the three Anny vertices it hangs from (for skinning it like the body under it). */
  anchors?: Uint32Array
  /** Per vertex, the barycentric weights of its three anchors. */
  anchorWeights?: Float32Array
}

export interface HairOptions {
  /** Repeats every triangle with the opposite winding, for renderers that cull back faces (hair cards are thin). */
  doubleSided?: boolean
}

/** The style's fitted CC0 mesh on these vertices (any Anny rest shape: fitted, stylised or dressed). */
export function fitHair(
  asset: HairAsset,
  styleId: string,
  vertices: Float32Array,
  options: HairOptions = {},
): HairMesh {
  const style = asset.styles.get(styleId)
  if (!style) throw new Error(`The hair asset has no style "${styleId}".`)
  const scale = (["x", "y", "z"] as const).map((axis, k) => {
    const [a, b, template] = asset.manifest.scale[axis]
    return Math.abs((vertices[a * 3 + k] ?? 0) - (vertices[b * 3 + k] ?? 0)) / template
  })
  const count = style.shade.length
  const copies = options.doubleSided ? 2 : 1
  const positions = new Float32Array(count * 3 * copies)
  const shade = new Float32Array(count * copies)
  const anchors = new Uint32Array(count * 3 * copies)
  const anchorWeights = new Float32Array(count * 3 * copies)
  for (let v = 0; v < count; v++) {
    const triangle = style.anchorTriangles[v] ?? 0
    const u = (style.weights[v * 2] ?? 0) / 255
    const w1 = (style.weights[v * 2 + 1] ?? 0) / 255
    const bary = [u, w1, Math.max(1 - u - w1, 0)]
    for (let corner = 0; corner < 3; corner++) {
      const vertex = asset.anchorFaces[triangle * 3 + corner] ?? 0
      anchors[v * 3 + corner] = vertex
      anchorWeights[v * 3 + corner] = bary[corner] ?? 0
      for (let axis = 0; axis < 3; axis++)
        positions[v * 3 + axis] =
          (positions[v * 3 + axis] ?? 0) + (bary[corner] ?? 0) * (vertices[vertex * 3 + axis] ?? 0)
    }
    for (let axis = 0; axis < 3; axis++)
      positions[v * 3 + axis] =
        (positions[v * 3 + axis] ?? 0) + (style.offsets[v * 3 + axis] ?? 0) * style.offsetStep * (scale[axis] ?? 1)
    shade[v] = (style.shade[v] ?? 255) / 255
  }
  const triangles = style.triangles.length / 3
  const indices = new Uint32Array(style.triangles.length * copies)
  indices.set(style.triangles)
  if (options.doubleSided) {
    // The back side gets its own vertices, so each side shades with its own normals.
    positions.copyWithin(count * 3, 0, count * 3)
    shade.copyWithin(count, 0, count)
    anchors.copyWithin(count * 3, 0, count * 3)
    anchorWeights.copyWithin(count * 3, 0, count * 3)
    for (let t = 0; t < triangles; t++) {
      indices[(triangles + t) * 3] = (style.triangles[t * 3] ?? 0) + count
      indices[(triangles + t) * 3 + 1] = (style.triangles[t * 3 + 2] ?? 0) + count
      indices[(triangles + t) * 3 + 2] = (style.triangles[t * 3 + 1] ?? 0) + count
    }
  }
  return { positions, indices, shade, anchors, anchorWeights }
}

/**
 * Hair geometry for a style over a shaped head. With the asset registered, the fitted CC0 mesh; otherwise a shell over
 * the painted scalp. `faces`, `regions`, `normals` and `frame` feed the fallback only.
 */
export function buildHair(
  style: HairStyle,
  vertices: Float32Array,
  normals: Float32Array,
  faces: ArrayLike<number>,
  regions: Uint8Array,
  _frame: HeadFrame,
  options: HairOptions = {},
): HairMesh {
  if (style.asset && registered?.styles.has(style.asset)) return fitHair(registered, style.asset, vertices, options)
  if (style.thickness <= 0) return { positions: new Float32Array(), indices: new Uint32Array() }
  const positions: number[] = []
  const indices: number[] = []
  const remap = new Map<number, number>()
  const capVertex = (v: number) => {
    const known = remap.get(v)
    if (known !== undefined) return known
    const index = positions.length / 3
    for (let axis = 0; axis < 3; axis++)
      positions.push((vertices[v * 3 + axis] ?? 0) + (normals[v * 3 + axis] ?? 0) * style.thickness)
    remap.set(v, index)
    return index
  }
  for (let t = 0; t < faces.length; t += 3) {
    const a = faces[t] ?? 0
    const b = faces[t + 1] ?? 0
    const c = faces[t + 2] ?? 0
    // A triangle with two scalp corners is kept too, so the shell reaches slightly past the painted hairline.
    const scalp = [a, b, c].filter((v) => regions[v] === Region.scalp).length
    if (scalp >= 2) indices.push(capVertex(a), capVertex(b), capVertex(c))
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) }
}
