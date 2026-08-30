# Git'o

Native VS Code sidebar for local Git repositories, worktrees, branches, tags, changes, and history.

Desktop VS Code only. Git'o runs beside the repository and requires VS Code's built-in Git extension.

## What works

- Clone through VS Code's built-in `Git: Clone` flow.
- Show only repositories belonging to the opened folder or multi-root workspace.
- Create and switch branches from actions inside the native Branches tree.
- Create feature worktrees through VS Code's Git API, list every linked worktree together, see clean/WIP/conflict state without opening it, rename local display labels, and open it in the current or a new window.
- Distinguish current, local-only, remote-only, tracked, ahead, behind, and diverged branches with native icons, semantic colours, labels, and tooltips.
- Prune selected local branches missing from every remote after a native fetch-prune and confirmation.
- Warn when the current branch is behind its configured upstream or its VS Code-detected source branch.
- Create and switch local tags from actions inside the native Tags tree.
- Automatically compare local tags with the default remote, or choose another remote manually, without fetching or pushing them.
- Write commit messages and commit through VS Code's built-in Git flow.
- Push branches and tags, choose a target, or force push through VS Code's native Git commands and safety settings.
- Highlight commit subjects beyond the recommended 50-character limit without blocking the commit.
- Browse, stage, unstage, discard, and resolve working-tree changes below the commit composer in one Changes view.
- Resolve conflicts through a plain-language guide that names the real branches and commit roles, then opens VS Code's native Merge Editor.
- Follow the guided Graph workflow for paged history, search, commit actions, sync previews, visual file history, and live worktree state.
- See subtle, theme-aware author, age, and commit context on the active line and in VS Code's status bar; open its commit, copy its hash, jump to file history, or toggle the annotation.
- Refresh automatically when VS Code's Git state changes.

Tag icons use native theme colours: green is synced, yellow is local only, blue is remote only, and red means the same tag name points to different commits.

Branch icons use native theme colours: green is current and synced, purple is ahead, yellow is behind or untracked, red is diverged, and blue is remote only. Text and icons repeat every state for accessibility.

## Getting started

VS Code opens Git'o's native **Get started with Git'o** walkthrough after installation. Its five short journeys cover every feature group without replacing the real interface:

1. Repositories, branches, tags, remote comparison, and pruning.
2. Changes, staging, commits, pushes, and conflict guidance.
3. Graph search, reusable diffs, sync previews, and guarded history actions.
4. Feature worktrees, status, labels, and window controls.
5. File history, current-line details, status-bar blame, and inline annotations.

Run **Git'o: Open Getting Started** from the Command Palette or choose **?** in the Git view to reopen it. The Graph also has its own contextual five-step tour.

## Explore the Graph

Open a local repository, choose **Git'o** in the Activity Bar, then expand **Graph**. A five-step tour appears the first time commits load; choose **?** above the graph to replay it.

1. Click a commit to inspect its changed files and diff in one reusable tab.
2. Hover a commit and choose **•••** to compare it, copy its hash, create a branch or local tag, inspect it detached, apply or revert it, move the current branch, or undo HEAD while keeping changes.
3. Search repository history with text or `author:`, `message:`, `ref:`, and `file:` filters. Choose **Load 50 more** to page through older commits.
4. Choose **Sync · _upstream_** to preview incoming and outgoing commits, changed paths, and predicted conflicts before Pull or Push.
5. Right-click a file and choose **Git'o: Show File History**. Linked worktrees appear above the graph with their branch and clean, WIP, or conflict state.

Potentially destructive graph actions require confirmation. Actions that need a clean working tree remain unavailable until changes are committed, stashed, or discarded.

## Run locally

Open this folder in desktop VS Code and press `F5`.

Git'o uses VS Code's bundled Git API for standard operations and credentials. Commit-specific actions missing from that API run the local Git executable with argument arrays, confirmation, timeouts, and no shell. Git'o stores no credentials.

Linked worktrees default to `.gito-worktrees/<repository>/<worktree>` beside the primary checkout, never inside it. Set `gito.worktrees.storageRoot` to an absolute path or a `~` path to keep every repository's worktrees under one global folder. Git'o stores custom worktree labels locally in VS Code; labels do not rename branches or folders.

## Validate

```sh
npm run check
```

For a repeatable local product benchmark against a generated 100-commit repository:

```sh
npm run benchmark:product
```

Release budgets: full-history search under 2 seconds, visual file history under 2 seconds, and linked-worktree WIP under 1 second. The normal `check` gate runs this benchmark.

## Current boundary

Cloud sharing, AI, pull-request management, and provider integration are intentionally outside this local-first slice. Local branch pruning is explicit and confirmed. Force push actions are isolated under `Rewrite remote history`; VS Code controls permission, confirmation, and force-with-lease behaviour.
