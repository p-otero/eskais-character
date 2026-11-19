// Demo page: a minimal stand-in for the UI library's ModelScan / ModelViewer. Samples are synthetic people.
import * as THREE from "three"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js"
import sampleBody from "../fixtures/synthetic/s000-body.png?url"
import sampleFace from "../fixtures/synthetic/s000-face.png?url"
import { createScanEngine, type ScanEvent } from "../src/scan/index.ts"

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id)
  if (!found) throw new Error(`#${id} is missing.`)
  return found as T
}

const log = element("log")
const engine = createScanEngine({ delegate: "auto" })
engine.ready.then(
  ({ delegate, ms }) => {
    log.textContent = `Models ready in ${ms.toFixed(0)} ms (MediaPipe on ${delegate}).\n`
  },
  (error: unknown) => {
    log.textContent = `Could not load the models: ${error instanceof Error ? error.message : "unknown error"}\n`
  },
)

const canvas = element<HTMLCanvasElement>("viewer")
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(30, 3 / 4, 0.1, 20)
camera.position.set(0, 0.2, 4.2)
const controls = new OrbitControls(camera, canvas)
let morphed: THREE.Mesh | null = null

function lights() {
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2.2), new THREE.DirectionalLight(0xffffff, 1.5))
}
lights()
renderer.setAnimationLoop(() => {
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false)
  camera.aspect = canvas.clientWidth / Math.max(canvas.clientHeight, 1)
  camera.updateProjectionMatrix()
  controls.update()
  renderer.render(scene, camera)
})

async function showGlb(glb: Uint8Array) {
  const gltf = await new GLTFLoader().parseAsync(glb.slice().buffer, "")
  scene.clear()
  lights()
  gltf.scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return
    const material = object.material as THREE.MeshStandardMaterial
    object.material = new THREE.MeshToonMaterial({
      color: material.color,
      vertexColors: material.vertexColors,
      side: material.side,
    })
    if (object.morphTargetInfluences) morphed = object
  })
  scene.add(gltf.scene)
  // Frame the whole character: the skinned meshes' bounds come from their rest pose.
  const box = new THREE.Box3().setFromObject(gltf.scene)
  const centre = box.getCenter(new THREE.Vector3())
  const height = box.max.y - box.min.y
  camera.position.set(centre.x, centre.y, centre.z + height / (2 * Math.tan((camera.fov * Math.PI) / 360)) + 0.5)
  controls.target.copy(centre)
}

function dots(canvasId: string, imageId: string, points: Float32Array) {
  const target = element<HTMLCanvasElement>(canvasId)
  const image = element<HTMLImageElement>(imageId)
  // Match the photo's rendered box, so normalised landmarks land on it.
  target.width = image.clientWidth
  target.height = image.clientHeight
  target.style.height = `${String(image.clientHeight)}px`
  const context = target.getContext("2d")
  if (!context) return
  context.fillStyle = "#22d3ee"
  for (let index = 0; index < points.length; index += 2)
    context.fillRect((points[index] ?? 0) * target.width - 1, (points[index + 1] ?? 0) * target.height - 1, 2, 2)
}

let face: Blob | undefined
let body: Blob | undefined
function preview(id: string, blob: Blob) {
  element<HTMLImageElement>(id).src = URL.createObjectURL(blob)
}
element<HTMLInputElement>("face").addEventListener("change", (event) => {
  face = (event.target as HTMLInputElement).files?.[0]
  if (face) preview("facePreview", face)
})
element<HTMLInputElement>("body").addEventListener("change", (event) => {
  body = (event.target as HTMLInputElement).files?.[0]
  if (body) preview("bodyPreview", body)
})
element("sample").addEventListener("click", async () => {
  face = await (await fetch(sampleFace)).blob()
  body = await (await fetch(sampleBody)).blob()
  preview("facePreview", face)
  preview("bodyPreview", body)
})

function handle(event: ScanEvent) {
  if (event.type === "stage" && event.ms !== undefined) log.textContent += `${event.stage}: ${event.ms.toFixed(0)} ms\n`
  if (event.type === "landmarks")
    dots(
      event.source === "face" ? "faceDots" : "bodyDots",
      event.source === "face" ? "facePreview" : "bodyPreview",
      event.points,
    )
  if (event.type === "model") void showGlb(event.glb)
  if (event.type === "progress") {
    element<HTMLProgressElement>("progress").value = event.value
    const influences = morphed?.morphTargetInfluences
    if (influences) event.weights.forEach((weight, index) => (influences[index] = weight))
  }
  if (event.type === "done") {
    void showGlb(event.character.glb)
    const { colors } = event.character
    element("swatches").replaceChildren(
      ...[colors.skin, colors.eyes, colors.hair, colors.brows, colors.beard].flatMap((color) => {
        if (!color) return []
        const swatch = document.createElement("span")
        swatch.style.background = color
        swatch.title = color
        return [swatch]
      }),
    )
    log.textContent += `hair: ${event.character.hair.id}\n${JSON.stringify(event.character.params.phenotype, null, 1)}\n`
  }
}

element("scan").addEventListener("click", async () => {
  if (!face) return
  const height = Number(element<HTMLInputElement>("height").value)
  for await (const event of engine.scan(
    { face, ...(body ? { body } : {}) },
    height ? { hints: { heightCm: height } } : {},
  ))
    handle(event)
})
