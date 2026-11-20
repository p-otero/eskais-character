# eskais-character

A local, in-browser engine that turns photos into a **stylised, rigged character with a face**, and later animates
it. Nothing is processed in the cloud.

The engine produces data only: a scan event stream, morph-target weights, colours, a hair choice and a GLB. Screens
live in the Eskais UI component library (`ModelViewer`, `ModelScan`), which consumes that data.

## Install

```sh
npm install eskais-character
# optional peers: react (for eskais-character/react), three (for eskais-character/three)
```

ESM only, for browsers and Electron renderers (WebGL2 required).

## Use

```ts
import { createScanEngine } from "eskais-character"

const engine = createScanEngine() // starts the worker and loads the models
const controller = new AbortController()

for await (const event of engine.scan({ face: faceFile, body: bodyFile }, { signal: controller.signal })) {
  if (event.type === "landmarks") drawPoints(event.points) // x, y pairs normalised to the photo
  if (event.type === "mask") setMask(event) // { source, width, height, data }: person confidence 0-255, ≤ 256 px
  if (event.type === "model") viewer.load(event.glb) // once: the base character with every morph target
  if (event.type === "progress") viewer.setWeights(event.weights) // live morphing while the fit converges
  if (event.type === "done") viewer.load(event.character.glb)
  if (event.type === "error") showError(event.error.code) // e.g. "no-face"
}

// Another look, without the photo:
const clay = await engine.restyle(character, { style: "clay", stylize: 0.8, hair: "ponytail" })
```

With three.js, `styleCharacter(gltf.scene)` from `eskais-character/three` builds the style the GLB was exported with
(toon ramp, rim light, outline). With React, `useCharacterScan(engine)` from `eskais-character/react` maps the events
to state.

### Bundlers and where the files come from

| File                                                       | Size                                           | Where it comes from                                                                                 |
| ---------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Scan worker (`dist/worker.js`, MediaPipe Tasks bundled in) | 0.46 MB (0.15 MB gzip)                         | Your bundler, from the package                                                                      |
| Body model (`assets/anny/anny.bin`)                        | 5.2 MB (1.1 MB brotli)                         | Your bundler, from the package; fallback `cdn.jsdelivr.net/npm/eskais-character@<version>/assets/…` |
| Hair styles (`assets/hair/hair.bin`)                       | 0.37 MB (0.19 MB brotli)                       | Same as the body model                                                                              |
| MediaPipe WASM and loader                                  | 15 MB (2.9 MB brotli)                          | `cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/wasm/`                                          |
| Face and pose models                                       | 3.8 + 9.4 MB (5.8 MB with `poseModel: "lite"`) | `storage.googleapis.com/mediapipe-models/…/float16/1/`                                              |

Every file is checked against a pinned size and SHA-256 before use, wherever it comes from. To serve everything
yourself, copy the files and pass `assetUrls` (same bytes, same hashes).

- **Vite** (dev and build), **webpack** and **Next.js** (Turbopack): nothing to configure. The worker and the model
  files are found through `new URL(…, import.meta.url)`, and the bundler emits them.
- **bun build** doesn't emit those files: copy `node_modules/eskais-character/dist/worker.js` to your static files
  and pass `createScanEngine({ workerUrl: "/worker.js" })`. The model files then come from the pinned CDN copy, or pass
  `assetUrls` for your own copies.
- A Content-Security-Policy needs `worker-src 'self' blob:`, `script-src 'self' 'wasm-unsafe-eval' blob:` and
  `connect-src` for the hosts above (see `demo/index.html`).

## Scope

- **Stylised, not realistic.** The face shape and body proportions are fitted to the person; skin, eye, hair, brow
  and beard colours are sampled from the photo; hair is picked from a CC0 catalogue and the user can change it;
  materials are toon-friendly.
- **It has a face**: fitted face modifiers plus the 52 ARKit-named expression morph targets, so it can be animated.
- **Runs entirely in a browser or Electron** on an ordinary PC, and on phones where possible: WASM, WebGL or WebGPU,
  Web Workers. No Python at runtime (Python is used only at build time to bake the Anny assets).
- **Commercial-safe licences only.** See [`LICENSES.md`](LICENSES.md) and [`docs/licences.md`](docs/licences.md).
  SMPL, SMPL-X and anything trained on SMPL or Max Planck data are forbidden.

| Module                    | What it is                                                         |
| ------------------------- | ------------------------------------------------------------------ |
| `eskais-character/scan`   | `scanCharacter({ face, body }, { signal })`: photos → event stream |
| `eskais-character/motion` | later: rig, glTF clips, retargeting                                |
| `eskais-character/react`  | `useCharacterScan(engine)`: maps scan events to props              |

## Privacy rules (hard constraints)

1. Photos are processed in memory, in a worker, and discarded; bitmaps are closed as soon as a stage is done.
2. The output is only the character: parameters, colours, hair choice and GLB. No pixels, crops or landmarks of
   the photo are kept in the result. During a scan the host page receives normalised landmarks and a person mask of
   at most 256 px (confidence only, no colour) for its transitions.
3. No logging of image data.
4. No network calls except fetching model and asset files from pinned URLs, checked by SHA-256.
5. **No real people's photos anywhere** in this repository: tests, demos, fixtures and screenshots use synthetic
   people rendered by `tooling/synth` from Anny with known parameters. CI fails on any image the generator did not
   produce.

## Try it on your own photo

A local-only check with a real photo. Nothing is uploaded, saved or committed.

```sh
bun install
bun run fetch:models    # once: the pinned MediaPipe models into .cache/models (SHA-256 checked)
bun run scan:photo -- --face path/to/face.jpg --body path/to/body.jpg --height 175
```

- `--face` is required; `--body` (front, A-pose, fitted clothes), `--height` (cm) and `--stylize` (0–1) are optional.
- The engine runs in headless Chrome on this machine with every network request outside the local files aborted;
  the photo is read into memory and never copied or written.
- Output goes to `.local/scans/<time>/`, which git ignores: a GLB and a front and side render per style, and
  `character.json` (fitted parameters, colours, hair). Delete the folder when you're done.
- The demo page (`bun run demo`) does the same in a browser tab with file inputs.

Never add a real photo, or anything rendered from one, to the repository or to CI: the image guard rejects any image
the synthetic generator did not produce.

## Status

Spike. See [`docs/spike-report.md`](docs/spike-report.md).

## Licence

MIT. Third-party notices (Anny, MediaPipe and the bundled assets keep their own Apache-2.0 and CC0 licences) are in [`LICENSES.md`](LICENSES.md).
