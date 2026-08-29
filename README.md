# Git'o

Smallest working product: a native VS Code sidebar for local Git repositories, branches, and tags.

Desktop VS Code only. Git'o runs beside the repository and requires VS Code's built-in Git extension.

## What works

- Clone through VS Code's built-in `Git: Clone` flow.
- Show only repositories belonging to the opened folder or multi-root workspace.
- Create and switch branches from actions inside the native Branches tree.
- Distinguish current, local-only, remote-only, tracked, ahead, behind, and diverged branches with native icons, semantic colours, labels, and tooltips.
- Prune selected local branches missing from every remote after a native fetch-prune and confirmation.
- Warn when the current branch is behind its configured upstream or its VS Code-detected source branch.
- Create and switch local tags from actions inside the native Tags tree.
- Compare local tags with a chosen remote without automatically fetching or pushing them.
- Write commit messages and commit through VS Code's built-in Git flow.
- Push branches and tags, choose a target, or force push through VS Code's native Git commands and safety settings.
- Highlight commit subjects beyond the recommended 50-character limit without blocking the commit.
- Browse staged, conflicted, untracked, and working-tree changes with native file decorations.
- Explore a compact, paged commit graph with branches, tags, authors, dates, and merge lanes.
- Refresh automatically when VS Code's Git state changes.

Tag icons use native theme colours: green is synced, yellow is local only, blue is remote only, and red means the same tag name points to different commits.

Branch icons use native theme colours: green is current and synced, purple is ahead, yellow is behind or untracked, red is diverged, and blue is remote only. Text and icons repeat every state for accessibility.

## Run locally

Open this folder in desktop VS Code and press `F5`.

Git'o delegates Git mutations, prompts, errors, and credentials to VS Code's bundled Git extension. It reads repository state and history through that extension, and stores no credentials.

## Validate

```sh
npm run check
```

## Current boundary

This slice does not merge, pull, or delete remote branches and tags. Local branch pruning is explicit and confirmed. Force push actions are isolated under `Rewrite remote history`; VS Code controls permission, confirmation, and force-with-lease behaviour.
