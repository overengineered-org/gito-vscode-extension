# Git'o repository guide

## Product boundary

- Build a desktop-first VS Code Git experience. Web/provider authentication is not in scope.
- Follow the repository and worktrees already opened in VS Code. Never invent workspace context.
- Prefer stable VS Code Git and workbench APIs. Use Git CLI only where VS Code exposes no adequate API.
- Prefer native VS Code views, commands, Quick Picks, icons, colours, and diff editors over custom HTML.
- Keep every smallest layer useful end to end before adding another capability.

## Git correctness

- Use fully qualified refs where ambiguity is possible. Basic history starts from `HEAD`.
- Distinguish local, remote-only, local-only, synced, ahead, behind, diverged, and conflicting tag targets.
- Never present remote state as checked until comparison or fetch succeeds. Surface failures with a retry path.
- Async views use latest-request-wins semantics without dropping initial readiness or visibility events.
- Reuse one commit/diff tab. Layout changes mutate that editor instead of opening duplicates.
- Destructive actions require an explicit target, clean-state guard, confirmation, and focused regression test.

## Experience

- State is never colour-only: pair colour with an icon and concise text.
- Use actual branch/ref names and plain operation roles. Avoid abstract Git jargon when a concrete name exists.
- Keep the active repository, branch, upstream, and worktree source explicit only where context could be ambiguous.
- Onboarding links must perform the described action or provide exact next clicks when editor focus is required.
- Do not open the maintainer's VS Code session unless explicitly asked. Test hosts must close automatically.

## Privacy and public OSS

- Never add PATs, tokens, secrets, tenant identifiers, personal names, emails, home paths, or credential stores.
- Provider auth, when added, must use standard browser OAuth with server-side exchange and public multi-tenant design.
- Run project actions through `.codex/environments/sanitized-command.sh` when practical.
- Public commits use `Repository Maintainer <repository-maintainer@overengineered.invalid>`.
- Do not mention competing products in tracked content, commits, release notes, or Marketplace copy.

## Validation and release

- Tests must protect a user-visible contract, lifecycle boundary, package contract, or regression. Remove checkbox tests.
- Validate unit, TypeScript, product benchmarks, Extension Host, exact VSIX, package contents, audits, and Gitleaks.
- Pull-request validation runs locally through the pinned reusable ACT environment plus native macOS checks.
- Release only from the exact current `main` SHA with an explicit patch, minor, or major increment.
- Build one VSIX once. Test and publish the identical checksum-backed bytes through the protected environment.
- Keep Marketplace credentials only in GitHub's protected `marketplace-production` environment.
- Commit messages are type-prefixed and at most 50 characters. Squash merge only.
- Before completion, score 20/20 for requirements, simplicity, suitable library reuse, no compatibility work, and durable layering.
