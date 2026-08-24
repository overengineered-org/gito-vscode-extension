# Production audit

Production approval requires every local gate, every hosted CI gate, and every
remote approval boundary below. A passing TypeScript or unit run alone is not a
release claim.

## Local gate

Run from a clean checkout:

```sh
npm ci
npm run verify:static
npm run test:release-policy
npm run build
npm run check:bundle
npm run package:vsix
npm run package:verify
npm run test:package
npm run test:production-audit
npm run audit:production
npm run security:scan
```

`verify:static` covers formatting, lint, types, the full meaningful test suite,
and the isolated performance suite. Packaging must produce exactly one
`dist/gito-<version>.vsix` and its checksum. `package:verify` checks the exact
archive allowlist and embedded semantic version. `security:scan` checks
credential-shaped values, workflow credential handling, and packaged privacy
paths.

## Required evidence

| Area           | Required proof                                                                                                                                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local Git      | Real temporary repositories and remotes cover state, mutation, cancellation, path safety, stale identity, branches, worktrees, history, and advanced operations.                                                     |
| Premium review | Real repositories cover diff sources/options/navigation, compare/search, conflicts, graph paging/merges, history/blame, and operation outcomes.                                                                      |
| Webviews       | Strict protocol tests, keyboard flow, accessible names, focus order, reduced motion, forced colors, high contrast, and 200% zoom.                                                                                    |
| Extension Host | Clean hosts on VS Code `1.132.0` and current stable; installed-VSIX evidence uses the exact packaged bytes on stable VS Code/Linux and an isolated Git fixture. macOS/Windows lanes run source Extension Host tests. |
| Providers      | Local adapter HTTP/auth tests; explicit live GitHub OAuth proof only with user authorization.                                                                                                                        |

Do not substitute jsdom for real Extension Host behavior, source bundles for an
installed VSIX, simulator/headless limitations for GUI evidence, or adapter
tests for live provider consent. A macOS headless run that exits in the native
UI layer is an environment blocker, not a passing installed-host result.

## CI gates

Hosted CI must remain green for static validation, unit, contract,
accessibility, security, performance, package policy, minimum and stable VS
Code, Linux Extension Host, installed VSIX, macOS, and Windows. The
installed-VSIX evidence is the stable VS Code/Linux lane; macOS and Windows
lanes run source Extension Host tests. CodeQL, dependency review, and secret
scanning must also remain green.

The installed-VSIX lane runs the Extension Host against the exact packaged bytes
on stable VS Code/Linux. Only that artifact may move to release promotion.

## Release boundary

Before a GitHub Release write, a protected workflow must verify:

1. The release source and tag match the tested commit.
2. CI succeeded for that source.
3. VSIX checksum, archive contents, embedded version, and source-tree
   fingerprint match.
4. The release is immutable and contains the intended VSIX, checksum, and
   provenance metadata.

Marketplace promotion uses the same verified release bytes and requires
separate authorized-maintainer approval through a protected workflow. Credentials
stay in the hosting provider's protected secret store; they do not belong in
the repository, package, logs, fixtures, or command arguments.

No local audit changes repository settings, creates a release or listing, sets a
secret, or publishes. Those actions require current authorized-maintainer
approval. The local build therefore claims no remote release, Marketplace
listing, or publication.

## Security review

Before release approval, inspect the final diff and packaged bundle for:

- token, PAT, private-key, credential-shaped, URL-userinfo, and raw provider
  error leakage;
- untrusted-workspace mutation paths and final trust checks;
- repository-root canonicalization, symlink and traversal safety, stale OID
  checks, and worktree identity;
- cancellation that stops subprocess work and prevents post-cancel state/UI
  commits;
- exact package contents, source-map exclusion, and deterministic release
  metadata.

Record failures with their file, command, cause, and remediation. Do not mark
the product production-finished while any required evidence is missing.
