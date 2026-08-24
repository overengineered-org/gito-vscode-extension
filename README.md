# Git'o

Open-source Git tooling for VS Code.

Git'o brings repository work, review, history, graph navigation, conflict
resolution, and optional pull-request context into one focused workspace. It
uses VS Code's bundled `vscode.git` extension for repository discovery, state,
and ordinary local Git API mutations. CLI-backed features use an absolute
`git.path` when configured, otherwise the executable path exposed by the
bundled extension. Cloud access stays optional.

## Start in two minutes

From the repository root:

```sh
npm ci
npm run build
npm run package:vsix
npm run package:verify
```

In VS Code Desktop:

1. Open **Extensions** → **Views and More Actions…** (`…`) → **Install from
   VSIX…**.
2. Choose `dist/gito-0.0.0-development.vsix`.
3. Open a Git repository and run **Git'o: Open Setup**.
4. Choose **Open or Choose a Git Repository**, then **Open Git'o Home**.

In a trusted workspace, the local Git workbench is ready without a Git'o
account, cloud connection, or browser sign-in. An untrusted workspace may
expose read-only inspection only. See [docs/ONBOARDING.md](docs/ONBOARDING.md)
for the complete walkthrough.

The Activity Bar and Marketplace icon use a violet-to-blue recoloring of the
Git mark adapted from Jason Long's work under [CC BY
3.0](https://creativecommons.org/licenses/by/3.0/). See [NOTICE](NOTICE) and
the [Git logo policy](https://git-scm.com/community/logos).

## What Git'o does

### Work locally

- **Home:** repository selection, branch state, staged/unstaged changes,
  ahead/behind status, fetch freshness, commit activity, and pull-request
  context.
- **Changes:** stage, unstage, discard with confirmation, commit, fetch, pull,
  push, sync, copy commit details, and open native VS Code diffs.
- **Branches and worktrees:** create, checkout, publish, delete with stale
  target checks, create/open/remove worktrees, and inspect repository state.
  Native worktree create/remove requires a desktop `file:` repository.

### Review with precision

- **Guided diff:** working tree, index, `HEAD`, revisions, merge-base, single
  file or repository-wide review, native VS Code diff editors, whitespace
  handling, side swapping, recent comparisons, and next/previous file or
  change navigation.
- **Compare and search:** compare branches, upstream, staged or working state,
  and revisions; inspect ahead/behind and file metrics; search commit subjects,
  bodies, authors, dates, and revisions with structured clauses, regex, paging,
  cancellation, and a review checklist.
- **Conflicts:** grouped conflict files, base/current/incoming previews,
  operation-aware language, keep-current, keep-incoming, combine, native Merge
  Editor, and explicit continue, skip, or abort actions.

### Understand the repository

- **Commit graph:** paged and virtualized history with merge lanes, local and
  remote refs, tags, stashes, worktrees, working-tree state, filters,
  minimap, and changed-line metrics.
- **History and blame:** file and line history, contributors, history search,
  current-line blame, recent-history CodeLens, revision navigation, commit
  details, and native revision diffs.
- **Operations Center:** preview and confirm stash, tags, merge, cherry-pick,
  revert, reset, rebase, remotes, reflog recovery, bisect, patch workflows,
  clean previews, and in-progress operation controls.

## Optional provider context

Cloud data is read-only and starts only after an explicit connection. In a
trusted workspace, local Git does not depend on either provider; an untrusted
workspace may expose read-only inspection only.

| Provider | Host         | VS Code session | Git'o data                                                |
| -------- | ------------ | --------------- | --------------------------------------------------------- |
| GitHub   | `github.com` | `github`        | Pull-request queues, details, status, and canonical links |

GitHub's VS Code provider controls `repo` and `read:user` scopes. `repo` is
broader than Git'o's read-only API use and may grant write-capable repository
access; Git'o does not represent this as least privilege.

Git'o has no account, backend, PAT flow, token store, telemetry, analytics,
diagnostics upload, tracking pixel, advertisement, or remote feature flag.
Provider tokens stay opaque inside the Extension Host request lifetime. They
never enter webviews, settings, files, caches, logs, fixtures, Git, or the
VSIX.

## Accessibility and platform boundary

The UI uses VS Code semantic theme tokens and native controls. Keyboard
navigation, screen-reader labels, reduced motion, forced colors, high contrast,
and zoom behavior are designed as product requirements. The release gate
requires evidence across Dark Modern, Light Modern, Dark High Contrast, Light
High Contrast, a customized third-party theme, keyboard navigation, screen
readers, reduced motion, forced colors, and 200% zoom. This repository does not
claim completed screenshot or installed-host evidence until those runs are
available.

Git'o targets VS Code Desktop and remote Extension Hosts where VS Code exposes
the bundled Git API, but remote Extension Host behavior is not live-proven by
current validation. Native worktree mutations require a desktop `file:`
repository. vscode.dev web extensions are outside the local-Git boundary.
Minimum engine: VS Code `1.132.0`.

## Development

Prerequisites: Node.js 24, npm, and VS Code Desktop for Extension Host tests.

```sh
npm ci
npm run verify:static
npm run build
npm run check:bundle
npm run package:vsix
npm run package:verify
npm run security:scan
```

Useful focused checks:

```sh
npm run test:unit
npm run test:contract
npm run test:accessibility
npm run test:security
npm run test:performance
npm run test:integration
npm run test:installed-vsix -- dist/gito-0.0.0-development.vsix
```

`test:integration` launches a clean VS Code Extension Host. CI's installed-VSIX
lane uses the exact packaged bytes on stable VS Code/Linux only and a temporary
Git repository; macOS and Windows CI lanes run source Extension Host tests.
On macOS, a headless host may stop in the native UI layer before the Extension
Host; that is an environment result, not a passing proof. Do not treat source
tests as installed-host or live provider proof.

## Release and Marketplace boundary

Semantic-release runs only from `main`: `fix:` is a patch, `feat:` is a minor,
and `feat!:` or `BREAKING CHANGE` is a major. Docs and chore-only changes do
not release.

The release candidate is one exact installed-tested
`gito-<version>.vsix` plus its `.sha256` file. Protected release workflows bind
those bytes to the tested source and tag, verify the checksum, archive contents,
embedded version, and source-tree fingerprint, then create an immutable GitHub
Release without rebuilding. The protected write rechecks the semantic version
against the installed-tested metadata. Recovery additionally requires the
latest completed successful exact-commit `main`/`push` CI, CodeQL,
dependency-review, and Gitleaks runs. Marketplace publication uses the same
verified bytes and requires separate authorized-maintainer approval through a
protected workflow. This local build proves no remote release, Marketplace
listing, or publication.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
[docs/PRODUCTION-AUDIT.md](docs/PRODUCTION-AUDIT.md),
[CONTRIBUTING.md](CONTRIBUTING.md),
[SECURITY.md](https://github.com/overengineered-org/gito-vscode-extension/blob/main/SECURITY.md),
and
[PRIVACY.md](https://github.com/overengineered-org/gito-vscode-extension/blob/main/PRIVACY.md).
