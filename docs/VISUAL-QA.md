# Visual QA

Visual evidence uses the exact installed Git'o VSIX in a real VS Code Desktop
renderer. Preact/jsdom tests remain useful for protocol and component behavior,
but they are not visual runtime evidence.

## Local capture

Build and package one exact archive first:

```sh
npm ci
npm run build
npm run package:vsix
npm run package:verify
```

Linux requires Xvfb with a 1440×900×24 display:

```sh
GITO_KEEP_TEST_ARTIFACTS=1 \
GITO_VISUAL_CAPTURE_ONLY=1 \
xvfb-run --auto-servernum --server-args="-screen 0 1440x900x24" \
npm run test:visual-vsix -- dist/gito-0.0.0-development.vsix
```

Without `GITO_VISUAL_OUTPUT_DIR`, artifacts stay in a temporary directory
outside the repository. Capture-only mode writes candidates and runtime
metadata. It does not update a golden baseline.

Normal validation compares every candidate with the checked-in approved
baseline. Missing or changed baselines fail closed.

When no complete baseline set exists, pull-request CI still captures real
runtime candidates and records `baselineStatus: "missing"`; it does not claim
golden approval. Run the manually dispatched `Visual baseline candidate capture`
workflow with the successful CI run ID for the exact commit. The workflow
downloads that run's installed-tested VSIX artifact; it never rebuilds or
repacks a substitute. Its `visual-baseline-approval` environment must have
required reviewers. Review the SHA-bound candidate artifact, rename each
`repository-home.png` and `repository-home.json` into the golden directory as
`<variant>.png` and `<variant>.json`, then add the approval manifest. No
workflow commits or copies candidates into the repository.

Release preflight requires all eight PNGs, all eight metadata sidecars, and a
manifest whose captured commit/source-tree/VSIX identifiers, reviewer, reason,
and screenshot digests bind the immutable approved baseline bytes. Current
release visual proof remains the installed-VSIX CI comparison; the approval
manifest is deliberately not self-referential to the current source tree.
The manifest fields are `schemaVersion: 1`, `status: "approved"`,
`capturedFromCommitSha`, `capturedFromSourceTreeSha256`,
`capturedFromVsixSha256`, `reviewer`, `approvedAt`, `reason`, and the ordered
eight-variant `variants` entries with `<variant>.png`, `<variant>.json`, and
`screenshotSha256`.

## Required evidence

The runner captures Dark Modern, Light Modern, Dark High Contrast, Light High
Contrast, and the repository-owned `Git'o Visual QA` custom theme. It also runs
200% zoom, forced colors, reduced motion, keyboard traversal, and runtime
accessibility-tree checks.

Dark and Light High Contrast select the corresponding VS Code high-contrast
themes. The separate forced-colors case keeps Dark Modern selected and emulates
the `forced-colors` media feature, so the two checks do not conflate theme and
browser media behavior.

Every screenshot sidecar records the VSIX SHA-256, source-tree SHA-256, commit,
VS Code version, theme, zoom, media settings, viewport, and screenshot digest.

The screenshot target is the loaded `#gito-root` inside the actual Repository
Home Webview. No Webview message mocking or browser-only app replacement is
allowed.

## Baseline approval

Baseline files live under `test/visual/golden/repository-home/`. The normal
visual test never writes them. Baseline changes require the protected visual
baseline approval workflow and a reviewer approval bound to the exact tested
VSIX SHA, commit, baseline digest, and reason.

## Screen readers

The automated lane checks the real DOM, accessible names, roles, states, live
regions, focus order, and Chromium accessibility tree. This does not prove
screen-reader speech.

Complete [VISUAL-QA-SCREEN-READER-CHECKLIST.md](VISUAL-QA-SCREEN-READER-CHECKLIST.md)
manually with VoiceOver on macOS and NVDA or Narrator on Windows. Record the
screen reader, OS, VS Code version, exact VSIX SHA, theme, zoom, and transcript
or recording. Linux CI is not treated as screen-reader proof.
