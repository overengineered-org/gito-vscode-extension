#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -eq 0 ]]; then
  echo "error: command required" >&2
  exit 64
fi

readonly sanitized_environment_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly project_worktree_root="$(cd -- "${sanitized_environment_directory}/../.." && pwd -P)"
readonly sanitized_runtime_root="${project_worktree_root}/.codex-runtime"
readonly sanitized_runtime_identifier="$(printf '%s' "$project_worktree_root" | cksum | awk '{print $1}')"
readonly sanitized_temporary_root="/tmp/gito-codex-${sanitized_runtime_identifier}"

mkdir -p \
  "${sanitized_runtime_root}/cache" \
  "${sanitized_runtime_root}/config" \
  "${sanitized_runtime_root}/data" \
  "${sanitized_runtime_root}/home" \
  "${sanitized_runtime_root}/npm-cache" \
  "$sanitized_temporary_root"

export HOME="${sanitized_runtime_root}/home"
export USER="repository-maintainer"
export LOGNAME="repository-maintainer"
export TMPDIR="$sanitized_temporary_root"
export XDG_CACHE_HOME="${sanitized_runtime_root}/cache"
export XDG_CONFIG_HOME="${sanitized_runtime_root}/config"
export XDG_DATA_HOME="${sanitized_runtime_root}/data"
export GIT_CONFIG_GLOBAL="${project_worktree_root}/.codex/environments/gitconfig"
export GIT_CONFIG_SYSTEM=/dev/null
export GIT_TERMINAL_PROMPT=0
export GH_CONFIG_DIR="${sanitized_runtime_root}/config/gh"
export NPM_CONFIG_USERCONFIG="${project_worktree_root}/.codex/environments/npmrc"
export NPM_CONFIG_CACHE="${sanitized_runtime_root}/npm-cache"

for inherited_git_configuration_variable in \
  "${!GIT_CONFIG_KEY_@}" \
  "${!GIT_CONFIG_VALUE_@}"; do
  if [[ -n "$inherited_git_configuration_variable" ]]; then
    unset "$inherited_git_configuration_variable"
  fi
done

unset \
  ANTHROPIC_API_KEY \
  ARM_CLIENT_ID \
  ARM_CLIENT_SECRET \
  ARM_TENANT_ID \
  AWS_ACCESS_KEY_ID \
  AWS_PROFILE \
  AWS_SECRET_ACCESS_KEY \
  AWS_SESSION_TOKEN \
  AZURE_CLIENT_ID \
  AZURE_CLIENT_SECRET \
  AZURE_DEVOPS_EXT_PAT \
  AZURE_TENANT_ID \
  DATABRICKS_CONFIG_FILE \
  DATABRICKS_HOST \
  DATABRICKS_TOKEN \
  EMAIL \
  GIT_ASKPASS \
  GIT_AUTHOR_EMAIL \
  GIT_AUTHOR_NAME \
  GIT_COMMITTER_EMAIL \
  GIT_COMMITTER_NAME \
  GIT_CONFIG_COUNT \
  GIT_COMMON_DIR \
  GIT_DIR \
  GIT_INDEX_FILE \
  GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES \
  GIT_SSH \
  GIT_SSH_COMMAND \
  GIT_WORK_TREE \
  GITHUB_TOKEN \
  GH_TOKEN \
  GOOGLE_APPLICATION_CREDENTIALS \
  NODE_AUTH_TOKEN \
  NPM_TOKEN \
  OPENAI_API_KEY \
  SSH_ASKPASS \
  SSH_AUTH_SOCK \
  VSCE_PAT \
  YARN_NPM_AUTH_TOKEN

if git -C "$project_worktree_root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  readonly worktree_git_user_name="$(git -C "$project_worktree_root" config --local --get user.name || true)"
  readonly worktree_git_user_email="$(git -C "$project_worktree_root" config --local --get user.email || true)"
  if [[ -n "$worktree_git_user_name" && "$worktree_git_user_name" != "Repository Maintainer" ]] || \
    [[ -n "$worktree_git_user_email" && "$worktree_git_user_email" != "repository-maintainer@overengineered.invalid" ]]; then
    echo "error: run bash .codex/environments/setup.sh to sanitise this worktree's Git identity" >&2
    exit 1
  fi
fi

cd "$project_worktree_root"
exec "$@"
