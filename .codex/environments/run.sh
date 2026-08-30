#!/usr/bin/env bash
set -euo pipefail

readonly sanitized_environment_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly project_worktree_root="$(cd -- "${sanitized_environment_directory}/../.." && pwd -P)"
exec bash "${project_worktree_root}/scripts/run-with-node-24.sh" \
  bash "${project_worktree_root}/.codex/environments/sanitized-command.sh" \
  "$@"
