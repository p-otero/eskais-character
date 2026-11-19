# eskais-character

A local, in-browser engine that turns photos into a **stylised, rigged character with a face**, and later animates
it. Nothing is processed in the cloud.

The engine produces data only: a scan event stream, morph-target weights, colours, a hair choice and a GLB. Screens
live in the Eskais UI component library (`ModelViewer`, `ModelScan`), which consumes that data.

## Scope

- **Stylised, not realistic.** The face shape and body proportions are fitted to the person; skin, eye, hair, brow
  and beard colours are sampled from the photo; hair is picked from a CC0 catalogue and the user can change it;
  materials are toon-friendly.
- **It has a face**: fitted face modifiers plus the 52 ARKit-named expression morph targets, so it can be animated.
- **Runs entirely in a browser or Electron** on an ordinary PC, and on phones where possible: WASM, WebGL or WebGPU,
  Web Workers. No Python at runtime (Python is used only at build time to bake the Anny assets).
- **Commercial-safe licences only.** See [`LICENSES.md`](LICENSES.md) and [`docs/licences.md`](docs/licences.md).
  SMPL, SMPL-X and anything trained on SMPL or Max Planck data are forbidden.

| Module                     | What it is                                                        |
| -------------------------- | ----------------------------------------------------------------- |
| `eskais-character/scan`    | `scanCharacter({ face, body }, { signal })`: photos → event stream |
| `eskais-character/motion`  | later: rig, glTF clips, retargeting                                |
| `eskais-character/react`   | `useCharacterScan(engine)`: maps scan events to props             |

## Privacy rules (hard constraints)

1. Photos are processed in memory, in a worker, and discarded; bitmaps are closed as soon as a stage is done.
2. The output is only the character: parameters, colours, hair choice and GLB. No pixels, crops or landmarks of
   the photo are kept in the result.
3. No logging of image data.
4. No network calls except fetching model and asset files from pinned URLs, checked by SHA-256.
5. **No real people's photos anywhere** in this repository: tests, demos, fixtures and screenshots use synthetic
   people rendered by `tooling/synth` from Anny with known parameters. CI fails on any image the generator did not
   produce.

## Status

Spike. See [`docs/spike-report.md`](docs/spike-report.md).

## Licence

Apache-2.0. Third-party notices are in [`LICENSES.md`](LICENSES.md).
