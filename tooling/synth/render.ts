import { bodyCoefficients, evaluateShape, type AnnyModel } from "../../src/model/anny.ts"
import { eyeballs } from "../../src/model/eyes.ts"
import { buildHair, hairStyle } from "../../src/model/hair.ts"
import { headFrame, meshParts, paintRegions, Region } from "../../src/model/regions.ts"
import { createFrame, drawMesh, resolve, vertexNormals, type Camera, type Light } from "./raster.ts"
import type { Rgb, Subject } from "./subjects.ts"

export function srgbToLinear(color: Rgb): [number, number, number] {
  return color.map((channel) => {
    const c = channel / 255
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }) as [number, number, number]
}

export interface RenderedImage {
  width: number
  height: number
  rgba: Uint8Array
}

const supersample = 2
const clothing: [number, number, number] = [0.05, 0.06, 0.08]

export function prepareSubject(model: AnnyModel, subject: Subject) {
  const face = model.faceModifierLabels.map((label) => subject.face[label] ?? 0)
  const { vertices, bones } = evaluateShape(model, { body: bodyCoefficients(model, subject.phenotype), face })
  const normals = vertexNormals(vertices, model.faces)
  const parts = meshParts(model, vertices)
  const frame = headFrame(model, bones, vertices, parts)
  const regions = paintRegions(model, vertices, normals, frame, parts)
  const style = hairStyle(subject.hair)
  const skin = srgbToLinear(subject.colors.skin)
  const lips = skin.map((channel, k) => channel * [0.78, 0.5, 0.52][k]!) as [number, number, number]
  const hair = srgbToLinear(subject.colors.hair)
  const brows = srgbToLinear(subject.colors.brows)
  const beard = subject.colors.beard ? srgbToLinear(subject.colors.beard) : null
  const boneY = (name: string) => bones[model.boneLabels.indexOf(name) * 3 + 1] ?? 0
  const shortsTop = boneY("spine04") + 0.02
  const shortsBottom = (boneY("upperleg02.L") + boneY("lowerleg01.L")) / 2
  const topTop = boneY("spine01") + 0.04
  const topBottom = boneY("spine02") - 0.03
  const female = subject.phenotype.gender > 0.5
  const colors = new Float32Array(vertices.length)
  for (let v = 0; v < model.vertexCount; v++) {
    const y = vertices[v * 3 + 1] ?? 0
    const x = Math.abs(vertices[v * 3] ?? 0)
    const torso = x < 0.22
    let color: [number, number, number] = skin
    const region = regions[v]
    if (region === Region.lips) color = lips
    else if (region === Region.brows) color = brows
    else if (region === Region.scalp && style.length !== "none") color = hair
    else if (region === Region.beard && beard) color = beard
    else if (region === Region.mouthInside) color = [0.08, 0.02, 0.02]
    else if ((y < shortsTop && y > shortsBottom && torso) || (female && y < topTop && y > topBottom && torso))
      color = clothing
    colors.set(color, v * 3)
  }
  const kept: number[] = []
  for (let t = 0; t < model.faces.length; t += 3)
    if ((parts[model.faces[t] ?? 0] ?? 0) < 2)
      kept.push(model.faces[t] ?? 0, model.faces[t + 1] ?? 0, model.faces[t + 2] ?? 0)
  const bodyIndices = new Uint16Array(kept)
  const eyes = eyeballs(frame, srgbToLinear(subject.colors.eyes))
  const hairMesh = buildHair(style, vertices, normals, model.faces, regions, frame)
  const hairColors = new Float32Array(hairMesh.positions.length)
  for (let v = 0; v < hairColors.length; v += 3) hairColors.set(hair, v)
  const elevation = subject.light.elevation
  const lights: Light[] = [
    {
      direction: [
        Math.sin(subject.light.azimuth),
        Math.sin(elevation),
        Math.cos(subject.light.azimuth) * Math.cos(elevation),
      ],
      intensity: 0.85,
    },
    { direction: [-0.6, 0.2, 0.5], intensity: 0.25 },
  ]
  const background = srgbToLinear(subject.background)
  const meshes = [
    { positions: vertices, colors, indices: bodyIndices },
    { ...eyes, gloss: new Float32Array(eyes.positions.length / 3).fill(0.6) },
    { positions: hairMesh.positions, colors: hairColors, indices: hairMesh.indices },
  ]
  const [mx, my, mz] = frame.eyeMid
  const faceCamera: Camera = {
    eye: [mx, my - 0.02, mz + 0.62],
    target: [mx, my - 0.025, mz],
    fovY: 0.5,
    width: 640 * supersample,
    height: 640 * supersample,
  }
  let top = Number.NEGATIVE_INFINITY
  let bottom = Number.POSITIVE_INFINITY
  for (let v = 1; v < vertices.length; v += 3) {
    top = Math.max(top, vertices[v] ?? 0)
    bottom = Math.min(bottom, vertices[v] ?? 0)
  }
  const middle = (top + bottom) / 2
  const bodyCamera: Camera = {
    eye: [0, middle + 0.05, 3.6],
    target: [0, middle, 0],
    fovY: 2 * Math.atan(((top - bottom) * 0.6) / 3.6),
    width: 540 * supersample,
    height: 960 * supersample,
  }
  return { vertices, bones, frame, parts, regions, bodyIndices, meshes, lights, background, faceCamera, bodyCamera }
}

export function renderSubject(model: AnnyModel, subject: Subject): { face: RenderedImage; body: RenderedImage } {
  const scene = prepareSubject(model, subject)
  const draw = (camera: Camera) => {
    const target = createFrame(
      camera.width,
      camera.height,
      (_, v) => scene.background.map((c) => c * (1.1 - 0.25 * v)) as [number, number, number],
    )
    for (const mesh of scene.meshes) if (mesh.indices.length > 0) drawMesh(target, mesh, camera, scene.lights, 0.28)
    return resolve(target, supersample)
  }
  return { face: draw(scene.faceCamera), body: draw(scene.bodyCamera) }
}

export { supersample }

/** Truth and fitted character side by side (truth left), same camera and light: the visual check of a scan. */
export function renderComparison(
  model: AnnyModel,
  truth: Subject,
  fitted: Subject,
): { face: RenderedImage; body: RenderedImage } {
  const left = renderSubject(model, truth)
  const right = renderSubject(model, { ...fitted, light: truth.light, background: truth.background })
  const join = (a: RenderedImage, b: RenderedImage): RenderedImage => {
    const width = a.width + b.width
    const rgba = new Uint8Array(width * a.height * 4)
    for (let y = 0; y < a.height; y++) {
      rgba.set(a.rgba.subarray(y * a.width * 4, (y + 1) * a.width * 4), y * width * 4)
      rgba.set(b.rgba.subarray(y * b.width * 4, (y + 1) * b.width * 4), (y * width + a.width) * 4)
    }
    return { width, height: a.height, rgba }
  }
  return { face: join(left.face, right.face), body: join(left.body, right.body) }
}
