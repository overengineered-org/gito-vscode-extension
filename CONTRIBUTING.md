# Contributing

## Validate a change

Run the complete local gate from a clean branch:

```sh
npm run verify:local
```

Prerequisites: Docker, `act`, Gitleaks, Git, and Node.js 24.14.0 through `nvm` or the host `PATH`.

The gate reuses one pinned Ubuntu container for Linux stable/minimum VS Code tests, the exact VSIX contract, both npm audits, and CodeQL. It then tests those bytes in native macOS VS Code, scans Git history and current changes for secrets, and checks an explicit patch release dry run. Only dangling Docker images are pruned.

Codex contributors should choose the repository's `gito-sanitized-local` environment. Its actions replace personal Git identity and isolate credential/configuration paths before executing project commands.

After pushing the exact clean commit and opening a conventionally titled pull request, publish its required status:

```sh
npm run verify:local:report
```

This posts one `Local validation` commit status. Pull requests and pushes do not start GitHub-hosted validation.

## Release

Releases are manual. After squash-merging to `main`, run the **Release** workflow with the full 40-character SHA currently at `main` and an explicit `patch`, `minor`, or `major` increment. It builds one versioned VSIX, tests those exact bytes on Linux, macOS, Windows, and minimum VS Code, uploads CodeQL SARIF, creates the GitHub Release, verifies its checksum, then publishes through the protected `marketplace-production` environment.
