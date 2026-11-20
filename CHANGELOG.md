# Changelog

## 0.1.0 (unreleased)

First release: a local, in-browser engine that turns a face photo (and optionally a full-body photo) into a
stylised, rigged character with a face. Nothing leaves the browser.

- `createScanEngine()` / `scanCharacter()`: an async event stream (`stage`, `landmarks`, `model`, `progress`, `done`,
  `error`) from a module worker. MediaPipe Face and Pose Landmarker, a fit of NAVER Anny's body phenotypes and face
  modifiers with learned priors, colour sampling (skin, eyes, hair, brows, beard), and a hair pick.
- The character as a GLB: skinned to Anny's 104-bone rig, with morph targets for the body, face modifiers and the 52
  ARKit-named expressions; eyes and hair as separate meshes.
- Looks: four styles (`soft-toon`, `cel-outline`, `low-poly`, `clay`), a `stylize` amount, an outfit (tee or hoodie,
  joggers, sneakers) and ten hair choices from CC0 MakeHuman assets. `engine.restyle()` changes any of them without the
  photo.
- `eskais-character/three`: reference three.js materials for the styles (toon ramp, rim light, inverted-hull
  outline). `eskais-character/react`: `useCharacterScan(engine)`.
- Privacy: photos stay in memory in the worker; the only network requests fetch pinned, SHA-256-checked model files.
