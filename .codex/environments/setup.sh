#!/usr/bin/env bash
set -euo pipefail

readonly sanitized_environment_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly project_worktree_root="$(cd -- "${sanitized_environment_directory}/../.." && pwd -P)"
cd "$project_worktree_root"

for required_command in git gitleaks node npm; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "error: required tool missing: $required_command" >&2
    exit 1
  fi
done

git config --local user.name "Repository Maintainer"
git config --local user.email "repository-maintainer@overengineered.invalid"
git config --local commit.gpgSign false
git config --local tag.gpgSign false

bash .codex/environments/run.sh npm ci
bash .codex/environments/run.sh npm run build

printf 'Sanitized Git\n  %s <%s>\nNode %s | npm %s | Gitleaks %s\n' \
  "$(bash .codex/environments/sanitized-command.sh git config --global user.name)" \
  "$(bash .codex/environments/sanitized-command.sh git config --global user.email)" \
  "$(bash .codex/environments/run.sh node --version)" \
  "$(bash .codex/environments/run.sh npm --version)" \
  "$(gitleaks version)"
