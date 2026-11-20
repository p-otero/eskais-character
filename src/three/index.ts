// Reference three.js materials for the styles a character GLB carries in `extras.eskais` (three: optional peer).
// Outlines are inverted hulls: one extra vertex pass per mesh and no full-screen pass, so they stay cheap on phones,
// where a post-process edge pass would need full-resolution depth and normal targets.

import {
  BackSide,
  Color,
  DataTexture,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  MeshToonMaterial,
  NearestFilter,
  RedFormat,
  type Material,
  type Object3D,
} from "three"
import { rampLevel, stylePreset, type StyleId, type StylePreset } from "../model/style.ts"

export { stylePresets, styleIds, type StyleId, type StylePreset } from "../model/style.ts"

interface EskaisExtras {
  role?: string
  style?: StylePreset
}

function extrasOf(material: Material): EskaisExtras | undefined {
  return (material.userData as { eskais?: EskaisExtras }).eskais
}

/** The preset's light ramp as a 1D gradient map for MeshToonMaterial. */
export function rampTexture(preset: StylePreset, size = 64): DataTexture {
  const data = new Uint8Array(size)
  for (let index = 0; index < size; index++) data[index] = Math.round(rampLevel(preset, index / (size - 1)) * 255)
  const texture = new DataTexture(data, size, 1, RedFormat)
  const smooth = preset.ramp.softness > 0.05
  texture.minFilter = smooth ? LinearFilter : NearestFilter
  texture.magFilter = smooth ? LinearFilter : NearestFilter
  texture.needsUpdate = true
  return texture
}

function toonMaterial(source: Material, preset: StylePreset, ramp: DataTexture): MeshToonMaterial {
  const material = new MeshToonMaterial({
    color: new Color(1, 1, 1),
    vertexColors: true,
    gradientMap: ramp,
    side: source.side,
  })
  // three's toon shader honours flatShading (it compiles FLAT_SHADED from any material), but its types omit it.
  Object.assign(material, { flatShading: preset.flatShading })
  material.name = `${source.name}-${preset.id}`
  const rim = preset.rim
  material.onBeforeCompile = (shader) => {
    shader.uniforms["rimStrength"] = { value: rim.strength }
    shader.uniforms["rimPower"] = { value: rim.power }
    shader.fragmentShader = shader.fragmentShader
      .replace("void main() {", "uniform float rimStrength;\nuniform float rimPower;\nvoid main() {")
      .replace(
        "#include <opaque_fragment>",
        [
          "float rimFacing = clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0);",
          "outgoingLight += diffuseColor.rgb * (2.0 * rimStrength * pow(1.0 - rimFacing, rimPower));",
          "#include <opaque_fragment>",
        ].join("\n"),
      )
  }
  material.customProgramCacheKey = () => `eskais-toon-${String(rim.strength)}-${String(rim.power)}`
  return material
}

function outlineMaterial(preset: StylePreset): MeshBasicMaterial {
  const material = new MeshBasicMaterial({ color: new Color(...preset.outline.color), side: BackSide })
  material.name = `outline-${preset.id}`
  const width = preset.outline.width
  material.onBeforeCompile = (shader) => {
    shader.uniforms["outlineWidth"] = { value: width }
    shader.vertexShader = shader.vertexShader
      .replace("void main() {", "uniform float outlineWidth;\nvoid main() {")
      // Pushed out before morphing and skinning, so the hull follows both.
      .replace("#include <begin_vertex>", "#include <begin_vertex>\ntransformed += normalize(normal) * outlineWidth;")
  }
  material.customProgramCacheKey = () => "eskais-outline"
  return material
}

export interface StyleOptions {
  /** A preset id or preset; defaults to the style the GLB was exported with. */
  style?: StyleId | StylePreset
}

/**
 * Restyles a loaded character in place (GLTFLoader puts material extras in `material.userData`). Returns a function
 * that removes the outlines and disposes everything this created; it does not restore the original materials.
 */
export function styleCharacter(root: Object3D, options: StyleOptions = {}): () => void {
  const created: { dispose(): void }[] = []
  const outlines: Mesh[] = []
  const ramps = new Map<string, DataTexture>()
  const meshes: Mesh[] = []
  root.traverse((object) => {
    if (object instanceof Mesh && !(object.userData as { eskaisOutline?: boolean }).eskaisOutline) meshes.push(object)
  })
  for (const mesh of meshes) {
    const source = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    if (!source) continue
    const extras = extrasOf(source)
    const requested = options.style
    const preset = typeof requested === "string" ? stylePreset(requested) : (requested ?? extras?.style)
    if (!preset) continue
    let ramp = ramps.get(preset.id)
    if (!ramp) {
      ramp = rampTexture(preset)
      ramps.set(preset.id, ramp)
      created.push(ramp)
    }
    const material = toonMaterial(source, preset, ramp)
    created.push(material)
    mesh.material = material
    if (preset.outline.width <= 0 || extras?.role === "eyes") continue
    const outline = mesh.clone(false) as Mesh
    // One influences array for both, so live morph weights move the outline too.
    outline.morphTargetInfluences = mesh.morphTargetInfluences
    const hull = outlineMaterial(preset)
    created.push(hull)
    outline.material = hull
    outline.userData = { eskaisOutline: true }
    outline.renderOrder = mesh.renderOrder - 1
    mesh.parent?.add(outline)
    outlines.push(outline)
  }
  return () => {
    for (const outline of outlines) outline.removeFromParent()
    for (const item of created) item.dispose()
  }
}
