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
- Compare local tags with a chosen remote without automatically fetching or pushing them.
- Write commit messages and commit through VS Code's built-in Git flow.
- Push branches and tags, choose a target, or force push through VS Code's native Git commands and safety settings.
- Highlight commit subjects beyond the recommended 50-character limit without blocking the commit.
- Browse staged, conflicted, untracked, and working-tree changes with native file decorations.
- Resolve conflicts through a plain-language guide that names the real branches and commit roles, then opens VS Code's native Merge Editor.
- Explore a compact, paged commit graph with branches, tags, authors, dates, merge lanes, and full-history `author:`, `message:`, `ref:`, and `file:` search.
- Open visual file history from the editor or Explorer; change magnitude appears as `+ / −` counts and scaled graph nodes.
- See subtle, theme-aware author, age, and commit context on the active line and in VS Code's status bar; open its commit, copy its hash, jump to file history, or toggle the annotation.
- Toggle commit diffs between unified and side-by-side layouts in the existing commit tab.
- Refresh automatically when VS Code's Git state changes.

Tag icons use native theme colours: green is synced, yellow is local only, blue is remote only, and red means the same tag name points to different commits.

Branch icons use native theme colours: green is current and synced, purple is ahead, yellow is behind or untracked, red is diverged, and blue is remote only. Text and icons repeat every state for accessibility.

## Run locally

Open this folder in desktop VS Code and press `F5`.

Git'o delegates Git mutations, prompts, errors, and credentials to VS Code's bundled Git extension. It reads repository state and history through that extension, and stores no credentials.

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

This slice does not merge, pull, or delete remote branches and tags. Local branch pruning is explicit and confirmed. Force push actions are isolated under `Rewrite remote history`; VS Code controls permission, confirmation, and force-with-lease behaviour.
