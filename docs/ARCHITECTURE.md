# Architecture

Git'o is a desktop VS Code extension with one package and three runtime
bundles: the Extension Host, Repository Home webview, and Commit Graph
webview. The Extension Host owns Git, providers, trust, cancellation, and
normalized state. Webviews own presentation and user interaction.

## Design principles

1. **Local first.** Repository work remains available without a cloud account.
2. **Native where it matters.** Repository discovery, state, and ordinary local
   Git mutations use VS Code's bundled `vscode.git` API; file review and merge
   editing use native VS Code editors where available.
3. **Explicit boundaries.** Cloud access is opt-in and read-only. Mutations
   require workspace trust and a final trust check.
4. **Bounded work.** Paging, caps, cancellation, stale-generation checks, and
   repository identity checks protect the Extension Host from large or changing
   repositories.
5. **Protocol discipline.** Webview messages are versioned, strict, and
   validated at the boundary.

## Source layout

| Layer                                                   | Responsibility                                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `src/domain/`                                           | Provider-neutral repository and pull-request contracts                               |
| `src/extension/git/`                                    | Bundled VS Code Git API façade, repository discovery, history, and worktrees         |
| `src/extension/diff/` and `diffExperience/`             | Diff sources, parsing, bounded plans, native diff navigation, and recent comparisons |
| `src/extension/compare/` and `compareExperience/`       | Reference comparison, search, metrics, cancellation, and review checklist            |
| `src/extension/conflicts/` and `conflictExperience/`    | Conflict parsing, previews, resolution plans, and operation controls                 |
| `src/extension/operations/` and `operationsExperience/` | Preview/confirm advanced Git operations and state-aware controls                     |
| `src/extension/history/` and `historyExperience/`       | File/line history, blame, contributors, CodeLens, and revision navigation            |
| `src/extension/graph/` and `graphExperience/`           | Commit graph loading, lanes, paging, minimap, metrics, and actions                   |
| `src/extension/dashboard/` and `providers/`             | Local/cloud orchestration, provider sessions, caching, and pull-request data         |
| `src/webview/`                                          | Preact UI, semantic VS Code tokens, accessibility, and strict message handling       |
| `src/protocol/`                                         | Zod schemas for Home and Graph messages                                              |
| `scripts/`                                              | Build, package, archive, security, release, and Extension Host checks                |

Generated `dist/` bundles are build outputs, never a source of truth.

## Activation and runtime flow

`src/extension/activateGitoExtension.ts` calls
`composeGitoExtension()` from `src/extension/extensionComposition.ts`. Composition
constructs the services without starting repository or provider I/O, registers
commands and serializers, and attaches activation-owned disposables.

1. VS Code activates Git'o from the Activity Bar, a command, or a serialized
   panel.
2. Repository discovery binds the current Git repository and generation.
3. Local Home data and each provider dashboard load independently.
4. A stale repository, provider session, or request generation discards its
   result instead of mutating current state.
5. The Home and Graph panels receive only validated, normalized protocol
   messages.
6. Panel, repository, provider, and service disposal cancels pending work and
   releases listeners.

The extension's activation path stays synchronous; initial repository and
provider work begins after registration. Graph data is paged and rendered by a
virtualized webview instead of materializing an unbounded DOM.

## Git and provider boundaries

The local façade follows VS Code's bundled `vscode.git` API for repository
selection, state, stage/unstage, commit, fetch, pull, push, sync, branches, and
ordinary worktree state. CLI-backed features use `git.path` only when it is a
non-empty absolute setting; otherwise they resolve the executable path exposed
by the bundled extension. Advanced Git operations use a cancellation-aware
command runner bound to the exact authorized repository root. Native worktree
mutations additionally require a desktop `file:` repository with no URI
authority. The source never shells through untrusted path strings or accepts an
arbitrary repository root from a webview.

The GitHub adapter detects its supported host, normalizes responses, enforces
request deadlines and concurrency, and redacts failures. Authentication
sessions stay inside the Extension Host request lifetime. Git'o does not
persist provider tokens, create a backend, or expose provider writes.

## Webview boundary

Repository Home is built from `src/webview/main.tsx` into `dist/webview.js` and
the Commit Graph from `src/webview/graph/main.tsx` into `dist/graph.js` plus
`dist/graph.css`. Both use a per-render nonce, `default-src 'none'`, minimal
local resource roots, text rendering for untrusted content, and strict
Zod-validated messages. Unknown message types and excess fields are rejected.

The Extension Host is the only layer allowed to access `vscode`, Git roots,
provider sessions, and command execution. Webviews do not receive auth tokens,
raw provider responses, or unrestricted filesystem handles.

## Trust, cancellation, and consistency

`src/extension/security/workspaceTrustGuard.ts` is the shared mutation gate.
Read-only inspection can render in an untrusted workspace. Local Git changes,
advanced operations, checkout, worktree mutation, and other write paths must
re-check trust immediately before execution, after user confirmation.

Every long-running request accepts an `AbortSignal`. Repository identity and
generation checks run before and after service work. Output is capped while it
is streamed, not only after a large buffer has accumulated. UI error text is
redacted before display.

## Build and package boundary

`scripts/build.mjs` produces the three bundles. `scripts/package-release.mjs`
stages only the package manifest, documentation, media, and required bundles,
then emits `dist/gito-<version>.vsix`, its SHA-256 file, and local release
metadata. `scripts/validate-package-contents.mjs` enforces the exact archive
allowlist and embedded version. Source maps and tests are not packaged.

CI separately verifies formatting, lint, types, meaningful unit/contract/
accessibility/security/performance tests, Extension Host behavior, bundle
budgets, archive contents, and credential privacy. A local green run does not
prove hosted CI, a live provider tenant, installed-host GUI behavior, or
Marketplace publication.

## Platform boundary

The minimum supported engine is VS Code `1.132.0`. Git'o targets VS Code
Desktop and remote Extension Hosts where the bundled Git API is exposed, but
remote Extension Host behavior is not live-proven by current validation.
Native worktree mutations require a desktop `file:` repository. vscode.dev web
extensions are outside the local-Git boundary.
