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
- Explore a compact, paged commit graph with branches, tags, authors, dates, merge lanes, and full-history `author:`, `message:`, `ref:`, and `file:` search.
- Open commit actions inside the graph: compare with the current branch, copy hashes, create branches or local tags, inspect detached commits, apply or revert commits, move a branch, and safely undo HEAD.
- Preview incoming and outgoing commits, changed paths, and predicted conflicts before Pull or Push; unsafe or irrelevant actions remain unavailable.
- See every linked worktree's branch and live clean/WIP/conflict state without delaying graph history.
- Open visual file history from the editor or Explorer; change magnitude appears as `+ / −` counts and scaled graph nodes.
- See subtle, theme-aware author, age, and commit context on the active line and in VS Code's status bar; open its commit, copy its hash, jump to file history, or toggle the annotation.
- Refresh automatically when VS Code's Git state changes.

Tag icons use native theme colours: green is synced, yellow is local only, blue is remote only, and red means the same tag name points to different commits.

Branch icons use native theme colours: green is current and synced, purple is ahead, yellow is behind or untracked, red is diverged, and blue is remote only. Text and icons repeat every state for accessibility.

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
