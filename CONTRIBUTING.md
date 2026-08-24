# Contributing

## Setup

Use Node.js 24 and the locked dependencies:

```sh
npm ci
npm run verify
```

`npm run verify` is the complete local source, release, package, and security
gate. It runs formatting, lint, typecheck, all Vitest tests, performance
tests, build and bundle budgets, VSIX packaging and allowlist validation,
package policy tests, production-audit tests and
manifest checks, the production dependency audit, and the privacy/security
scan.

Focused local checks are:

```sh
npm run verify:static
npm run build
npm run check:bundle
npm run package:vsix
npm run package:verify
npm run test:release-policy
npm run test:production-audit-policy
npm run test:package
npm run security:scan
```

Run `npm run test:integration` on a desktop host when changing activation,
webview registration, or Extension Host behavior. CI's installed-VSIX lane
runs packaged and installed-host tests against exact VSIX bytes on stable
VS Code/Linux. Those runtime checks remain a separate CI gate and are not
implied by `npm run verify`. Never add provider tokens to fixtures, tests, logs,
settings, or environment files.

## Changes

1. Create a focused branch from `main`.
2. Keep technical identifiers in the `gito` namespace and human-facing copy in
   Git'o.
3. Reuse VS Code's bundled Git API for ordinary local Git mutations.
4. Keep cloud provider work read-only and explicit.
5. Update documentation and tests with behavior changes.
6. Do not commit generated `dist/` output, VSIX files, checksums, or secrets.

## Commits and pull requests

Use a Conventional Commit title and final squash title:

```text
feat(history): add paged commit details
fix(security): reject untrusted webview messages
docs: clarify provider scope
```

Accepted types are `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`,
`ci`, and `chore`. An optional scope uses lowercase letters, digits, and
hyphens. Use `!` or a `BREAKING CHANGE` footer for breaking changes.

Every contribution must include the DCO sign-off:

```text
Signed-off-by: Contributor Name <contributor@example.invalid>
```

There is no CLA service or contributor account. Pull requests merge by squash
only after all required checks and review conversations are complete.

## Release policy

Eligible squash commits on `main` are analyzed by semantic-release. `fix:` is a
patch, `feat:` is a minor release, and `feat!:` or `BREAKING CHANGE` is major.
Documentation and chore-only changes do not release. The Marketplace promotes
the exact GitHub Release VSIX after checksum verification through the protected
environment; no Marketplace credential is stored in the repository.
