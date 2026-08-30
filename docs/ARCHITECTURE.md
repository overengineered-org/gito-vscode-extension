# Architecture

## Product boundary

Git'o is a desktop VS Code extension. Standard Git actions use VS Code's built-in Git API. Missing commit-specific operations use the local Git executable without a shell. Credentials remain with VS Code and Git.

## Validation boundary

`npm run verify:local` is the pull-request gate:

1. ACT reuses one immutable Ubuntu image and CodeQL cache.
2. Linux tests the exact VSIX on stable and minimum VS Code.
3. Native macOS retests the exact VSIX.
4. Gitleaks and an explicit patch release dry run complete the host gate.
5. `verify:local:report` posts one status for the exact clean pushed commit.

GitHub Actions does not repeat ordinary pull-request or push validation.

## Release boundary

The explicit Release workflow accepts only the full SHA currently at `main` plus a patch, minor, or major increment. It never infers a version from squash-commit wording. One checksum-backed VSIX flows unchanged through Linux, macOS, Windows, minimum-version testing, GitHub Release creation, and protected Marketplace publication. Every downstream job rejects `main` drift. GitHub alone owns SARIF upload, release assets, protected secrets, and publication.

## Codex environment boundary

Repository actions can run through `.codex/environments/sanitized-command.sh`. It uses an ignored worktree-local home/cache, a credential-free npm configuration, an empty Git credential helper, a public-safe Git identity, and no inherited common provider tokens or SSH agent. The local operating system still owns the checkout path; sanitisation prevents credentials and personal identity from entering project commands or tracked files.
