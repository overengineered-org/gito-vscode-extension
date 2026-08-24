# Remote hardening plan

This public checklist describes intended Git hosting controls. It is a plan,
not proof that remote settings have been applied. Only authorized maintainers
should apply changes through protected administrative workflows and confirm the
effective state afterward.

## Repository

- Public visibility with squash merge as the only merge method.
- Merge commits and rebase merges disabled.
- Head branches deleted after merge; branch updates allowed.
- Wiki, Projects, Discussions, deploy keys, and webhooks disabled unless a
  documented product requirement appears.

## Main protection

- Pull requests required; stale approvals dismissed.
- Required conversation resolution and strict required status checks.
- Linear history and administrator enforcement.
- Force pushes and branch deletion blocked.
- Stable checks required for static validation, release policy, and tests.

## Security and release controls

- Secret scanning and push protection enabled.
- Private vulnerability reporting and Dependabot security updates enabled.
- CodeQL default setup enabled.
- Immutable releases enabled.
- Release-tag rules protected.
- Marketplace publication restricted to an authorized maintainer and a
  protected, least-privilege credential held outside the repository.

## Evidence boundary

Local files and tests do not prove remote settings. After an authorized change,
confirm the effective repository, branch, security, release, and collaborator
controls in the hosting provider's administrative surface or an audited
workflow. Never place credentials in the repository, package, logs, fixtures,
or command arguments.
