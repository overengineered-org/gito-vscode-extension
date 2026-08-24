# Git'o setup

Use the native VS Code walkthrough to get productive in one repository. In a
trusted workspace, Git'o starts with local Git; provider sign-in is optional
and explicit. An untrusted workspace may expose read-only inspection only.

## Before you open setup

Build and install the local VSIX:

```sh
npm ci
npm run build
npm run package:vsix
npm run package:verify
```

In VS Code Desktop, install `dist/gito-0.0.0-development.vsix`. Git'o opens
**Git'o: Open Setup** once, in VS Code's native walkthrough UI. You can start
without a repository and choose one in the first step. Reopen setup later from
the Command Palette with **Git'o: Open Setup**.

## Walkthrough steps

1. **Open or Choose a Git Repository**

   This invokes VS Code's bundled `git.openRepository` command. Select a
   folder in the native picker. You can begin setup with no folder open. Git'o
   marks the step complete only after a repository is available to the bundled
   Git API. Local Git mutations require a trusted workspace; an untrusted
   workspace may expose read-only inspection only.

2. **Open Git'o Home**

   Home loads local repository state: branch, changes, ahead/behind status,
   fetch freshness, activity, and available provider context. Home completion
   requires a selected repository and a successful load.

3. **Keep the bundled Git engine**

   Git'o uses VS Code's bundled Git extension for local repository actions. Keep
   Repository discovery, repository state, and ordinary local mutations use the
   `vscode.git` API. CLI-backed features use an absolute `git.path` when
   configured; otherwise they use the executable path exposed by the bundled
   extension. Native worktree create/remove requires a desktop `file:`
   repository, and remote Extension Host behavior is not live-proven. Keep that
   extension enabled. Source Control may remain visible. If duplicate
   navigation bothers you, right-click the built-in **Source Control** Activity
   Bar icon and clear its visibility toggle; this is optional and manual.
   Git'o cannot hide it for you. If you choose to hide it, run **Git'o: Confirm
   Source Control Was Manually Hidden** and explicitly confirm the action by
   selecting **Confirm** after the manual change. If you prefer it visible, run
   **Git'o: Keep Source Control Visible** instead. Git'o works either way.

   Keyboard: open the Command Palette, run **View: Focus Activity Bar**, use
   the arrow keys to reach **Source Control**, then use your platform's
   context-menu shortcut (often `Shift+F10`; use `fn` if your keyboard needs
   it) and clear **Source Control**. You can also use either Git'o acknowledgement
   command from the Command Palette before you make that choice.

4. **Connect GitHub (optional)**

   In the walkthrough or Home provider card, choose **Connect GitHub** only when
   you want GitHub.com pull-request data. VS Code owns the `github` session and
   its `repo` and `read:user` scopes. `repo` is broader than Git'o's read-only
   use and may grant write-capable repository access. Git'o does not request a
   separate token or run a PAT flow. If you do not want cloud data, choose
   **Git'o: Keep GitHub Disconnected**; this explicitly completes the optional
   step without changing provider state. If sign-in fails, Git'o announces the
   failure and offers the same retry-or-keep-disconnected choices.

5. **Finish or reopen setup**

   Skipping every cloud step leaves local Git usable in a trusted workspace.
   Reopen the native walkthrough any time with **Git'o: Open Setup**; it stays
   available from the Command Palette after a repository opens. Setup never
   opens a browser or starts a provider request automatically.

## After setup

Use the Git'o Activity Bar view or these command-palette entries:

- **Git'o: Open Repository Home** — dashboard and provider context.
- **Git'o: Open Guided Diff** — working tree, index, revisions, merge-base, and
  repository review.
- **Git'o: Resolve Conflicts** — operation-aware conflict previews and actions.
- **Git'o: Open Operations Center** — safe previews for advanced Git actions.
- **Git'o: Open Commit Graph** — paged, filterable history and references.

Only history decorations and CodeLens are opt-in. The master
`gito.history.enabled` gate must be true, plus `gito.history.blame.enabled` for
blame decorations or `gito.history.codeLens.enabled` for CodeLens. File
history, line history, contributors, and search remain available from the
Command Palette regardless of those settings. Revision navigation is reached
from an active history UI: recent-history CodeLens or current-line blame
hover/status actions (when enabled), then the commit action menu; it is not a
standalone Command Palette entry.

## Provider lifecycle

Provider connection is session-based. Disconnecting from Home clears Git'o's
provider dashboard data for the current session; it does not revoke the VS Code
authentication session. If a provider session expires or is revoked, Git'o
requires an explicit reconnect. Provider tokens are never copied to settings,
files, logs, caches, webviews, fixtures, Git, or the VSIX.

## Setup state

Git'o stores one local setup marker after the native first-install walkthrough
opens successfully. The marker only prevents that walkthrough from reopening
automatically; it does not represent an account, provider, repository, or
completion record. Current repository and provider status is session-scoped and
clears when the repository closes or a provider disconnects.

## Boundaries

Git'o does not provide a Git'o account, backend, telemetry, analytics, PAT
flow, remote feature flag, or cloud mutation API. Workspace trust is required
before local Git mutations and premium mutations. Local Git use without a
provider is fully available in a trusted workspace; an untrusted workspace may
offer read-only inspection only. Every mutation handler re-checks trust at the
final execution boundary.
