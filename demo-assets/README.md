# Demo assets

A synthetic person (fixture `s001`, rendered by `tooling/synth`; no real person) scanned by the engine, for the UI
library's `ModelScan` / `ModelViewer` docs. CC0 (see `LICENSE.md`). Regenerate with
`bun tooling/demo-assets/export.ts --subject=s001`.

| File                               | What it is                                                                          |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| `character-soft-toon.glb`          | The scanned character, soft toon style, 988,628 bytes (529,718 gzip)                |
| `character-cel-outline.glb`        | The same character, cel style with outline, 988,616 bytes                           |
| `photo-face.png`, `photo-body.png` | The synthetic photos the scan used                                                  |
| `scan-replay.json`                 | The scan's event stream (landmarks, stages, progress weights, done) with timestamps |
| `manifest.json`                    | Generator manifest of the photos (the repo's image guard re-renders them)           |
| `sizes.json`                       | Sizes written by the exporter                                                       |

## The GLBs

- glTF 2.0 with `KHR_mesh_quantization` (required): normals and morph targets are normalized bytes. three.js's
  `GLTFLoader` reads them with no extra decoder (no meshopt, Draco or KTX2).
- One skinned body mesh with 23 morph targets in `extras.targetNames`: `body.pc00`–`pc02` (the main body-shape
  components), `face.<modifier>.incr|decr` for 4 face modifiers, and 12 ARKit expressions as `expr.<name>`
  (blinks, jaw open, smile, frown, pucker, funnel, brows). Eyes and hair are separate skinned meshes.
- **Weights are scaled.** Each target is stored scaled to use the full byte range, so the weight to set is
  `weight × extras.targetScales[i]`. `mesh.weights` and every weight in `scan-replay.json` are already scaled. To
  drive an expression by its ARKit value `v`, set `morphTargetInfluences[i] = v * targetScales[i]`.
- Animations: `idle` (3 s loop) and `wave` (2.4 s, right arm). 104-joint skeleton (Anny's rig), rest A-pose.
- Materials carry the style in `extras.eskais` (`role`, `style` preset). `styleCharacter(scene)` from
  `eskais-character/three` builds the toon materials and outline; the plain glTF materials work too.

## Replaying the scan

`scan-replay.json` holds `{ subject, targetNames, targetScales, events }`. Events have `at` (ms from the start) and
follow the engine's `ScanEvent` shapes: `stage`, `landmarks` (`points` as x, y pairs normalised to the photo,
`aspect` the photo's width / height), `model` (`glb` names the file to load), `progress` (`value`, `weights` aligned
with `targetNames`), and `done` (the character's params, colours, hair and final weights).
