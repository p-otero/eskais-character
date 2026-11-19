# AGENTS.md

Rules for anyone, human or agent, changing this repository. `bun run verify` runs every check locally the way CI does.

## Scope

A local, in-browser engine that turns photos into a stylised, rigged character with a face. It produces data (scan
events, morph-target weights, colours, a hair choice, a GLB) and knows nothing about screens; the UI lives in the
Eskais UI library. Modules: `eskais-character/scan`, `eskais-character/motion`, `eskais-character/react`.

Runtime code (`src/**`) runs in browsers, Web Workers and Electron renderers: WASM, WebGL or WebGPU, no Node or Bun
APIs, no Python. Python is allowed only at build time (`tooling/bake`).

## Privacy (hard constraints)

1. Photos are processed in memory, in a worker, and discarded: close every `ImageBitmap` as soon as its stage is done.
2. The output is only the character: parameters, colours, hair choice and GLB. No pixels, crops or photo landmarks.
3. No logging of image data. `character/no-console` forbids `console.*` in `src/**`.
4. No network except fetching model and asset files from pinned URLs with a SHA-256 check, in `src/scan/loader.ts`
   only (`character/no-network-outside-loader`). Results sent from the worker never carry pixels
   (`character/no-image-data-in-messages`). A browser test intercepts every request during a scan and fails if any
   leaves for an unpinned URL or carries image data.
5. No real people's photos anywhere: see "Images".

## Images

Tests, demos, fixtures and screenshots use synthetic people only, rendered by `tooling/synth` from Anny with known
parameters. `bun tooling/check-images.ts --rerender` (CI `guards` job) fails on any image file in the tree that is not
a PNG listed with its SHA-256 in a generator manifest and tagged with the generator's `eskais-synthetic` tEXt chunk,
re-renders every listed subject and compares the pixels (≤ 2 per channel on 99.9% of pixels), and refuses raster
`data:image/…` URIs in source files. To add fixtures, run the generator; never add an image by hand.

## Licences

Everything must allow commercial use and redistribution.

1. Allowed: MIT, MIT-0, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, CC0-1.0, Unlicense, BlueOak-1.0.0; CC-BY-4.0
   for data only, with attribution in `LICENSES.md`. `node tooling/check-licences.mjs` walks every installed package and
   every file under `assets/` and fails on anything else.
2. A build-time tool outside the list goes in `licenceExceptions` in that script with the reason, and the check fails
   if it reaches the production dependency closure (today: `lightningcss`, MPL-2.0, Vite's CSS transform).
3. Every file under `assets/` and every remote model is listed in `assets/ASSETS.json` with source, licence and date
   checked; remote entries carry a versioned https URL, SHA-256 and size (`/latest/` URLs are refused).
4. Forbidden: SMPL, SMPL-X, FLAME (except a variant whose licence allows commercial use, confirmed first) and anything
   trained on SMPL or Max Planck data (DECA, EMOCA, MICA, SHAPY, AMASS…). Names matching that family fail the check.
5. Record each licence in `docs/licences.md` with the official link and the date checked, from the official source.

## Dependencies

1. Every dependency is an exact pin (`bunfig.toml`: `exact = true`); a `github:` dependency names a full commit.
2. Pin only releases at least 7 days old (`bunfig.toml`: `minimumReleaseAge = 604800`), and prefer the oldest that has
   what the code needs. `node tooling/check-dependency-age.mjs` checks the npm publish times; CI runs it with
   `--require-network`, offline it skips.
3. A pin that can't wait goes in `youngDependencyExceptions` in that script at its exact version, with the reason. The
   check says when it is old enough to remove.
4. `node tooling/check-lockfile.mjs` fails when `bun.lock` is missing, differs from `package.json`, or `node_modules`
   holds another version. CI installs with `bun install --frozen-lockfile`.

## TypeScript

`tsc -b` over two projects: `tsconfig.runtime.json` (`src`, DOM libs, no `@types/node`) and `tsconfig.tooling.json`
(tests, tooling, demo; Node and Bun types). Flags (`tsconfig.base.json`): `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`,
`noPropertyAccessFromIndexSignature`, `noUnusedLocals`, `noUnusedParameters`, `isolatedModules`,
`verbatimModuleSyntax`. Tooling `.mjs` files imported from TypeScript ship a `.d.mts` next to them.

## Lint

`.oxlintrc.json` extends the `base` preset of [`@p-otero/oxlint-rules`](https://github.com/p-otero/oxlint-rules)
(pinned to a commit), with `--deny-warnings`, and a type-aware pass (`tooling/oxlint-type-aware.json`) with a strict
`typescript/restrict-template-expressions` (no numbers, booleans, nullish, any, arrays or regexps in templates: wrap
them in `String()`) and the promise rules. The type-aware pass covers TypeScript only: untyped `.mjs` tooling has no
types to judge. Rules from that package are `p-otero/<rule>`.

1. Every suppression says why: `// oxlint-disable-next-line <rule> -- <reason>` (`p-otero/require-suppression-reason`).
2. `src/react/**` adds the `react` and `react-agents` rules. Effects live in hook modules (`use-*.ts` or `hooks/`,
   `p-otero/no-effect-outside-hooks`); derive during render, act in handlers, or subscribe with
   `useSyncExternalStore` before writing one. The component-shape rules are off: the module exports hooks.
3. Local rules (`tooling/oxlint-plugin-character`, on `src/**` only): `character/no-console`,
   `character/no-network-outside-loader`, `character/no-node-builtins`, `character/no-image-data-in-messages`. Their
   tests are in `test/unit/lint-rules.test.ts`.
4. `max-lines` (400) is off for `test/**` and `tooling/**`.

Formatting: `oxfmt` with eskais-ui's settings (`.oxfmtrc.json`: print width 120, no semicolons), checked in CI.

## Comments

- Don't narrate what the code does; rename and restructure until the intent is obvious.
- Comment only non-obvious rationale: upstream bugs or workarounds, platform or protocol constraints, security or
  performance reasoning.
- No commented-out code. No TODO without a linked issue. `p-otero/no-low-value-comments` enforces this.

## Tests

- Unit tests with Vitest (`test/unit`), including the fitting maths against Anny's own reference vertices.
- Property and fuzz tests with `fast-check` where the maths has invariants (fits recover known parameters, weights stay
  in range, GLB writer round-trips).
- Browser tests in real Chrome through Playwright (`bun run test:browser`), WebGL and WebGPU through SwiftShader where
  available: the scan end to end on the synthetic set, a worker and WASM smoke test, the WebGL/WebGPU capability
  fallback, and the privacy test that intercepts the network. Electron uses the same Chromium; it is not tested
  separately yet.
- Every GLB the engine writes passes the Khronos glTF-Validator with no errors (`node tooling/validate-glb.mjs`).

## Performance

`bun run perf:ci` checks `tooling/perf/budgets.json` in CI on the committed fixtures with the CPU delegate: time per
stage and model load (4× headroom, since machines differ), download size per asset (gzip and brotli, 5%), memory of
page and worker (25%), character GLB size (5%), and main-thread blocking: no long task over 50 ms during a scan;
everything heavy runs in the worker. It prints every metric against its budget and writes
`tooling/perf/results/ci.json`. Over budget: make the change fit, or run `bun tooling/perf/ci.ts --update` and say why
in the commit. `bun run perf` is the full measurement behind the spike report (CPU, GPU, phone emulation, accuracy).

## Commands

| Command                           | What it does                                                           |
| --------------------------------- | ---------------------------------------------------------------------- |
| `bun run verify`                  | everything below, as CI runs it                                        |
| `bun run lint`                    | oxlint, then the type-aware pass                                       |
| `bun run format` / `format:check` | oxfmt                                                                  |
| `bun run typecheck`               | `tsc -b`                                                               |
| `bun run test`                    | Vitest                                                                 |
| `bun run guards`                  | image guard with re-render, licence check, lockfile check              |
| `bun run deps:age`                | dependency age check                                                   |
| `bun run fetch:models`            | download the pinned MediaPipe models into `.cache/models`, SHA-checked |
| `bun run test:browser`            | browser tests in Chrome                                                |
| `bun run perf:ci`                 | performance budgets                                                    |
| `bun run synth`                   | render synthetic people                                                |
| `bun run glb:validate <paths>`    | Khronos glTF-Validator on GLB files                                    |
| `bun run bake`                    | re-bake Anny (Python venv from `tooling/bake/requirements.txt`)        |
| `bun run calibrate`               | re-calibrate the landmark map, body calibration and learned priors     |
| `bun run evaluate`                | recovery on the held-out synthetic set (seed 1)                        |
| `bun run side-by-side`            | truth-vs-fit images in `docs/images` (generator output, guarded)       |
| `bun run perf`                    | full performance and accuracy report                                   |

Calibration trains on synthetic seeds 1000 (face map), 2000 (body calibration) and 4000 (priors, 300 people); seed 1
is held out for evaluation. Never evaluate on a training seed.

## Git

Commit as the repository's configured author. The repository is private: don't make it public, publish to npm or
create releases without the owner's explicit authorisation. Generic names only.
