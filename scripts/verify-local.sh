#!/usr/bin/env bash
set -euo pipefail

readonly project_worktree_root="$(git rev-parse --show-toplevel)"
readonly local_validation_context="Local validation"
readonly report_status_argument="--report-status"
report_status=false

if [[ "$#" -gt 1 ]]; then
  echo "Usage: ./scripts/verify-local.sh [${report_status_argument}]" >&2
  exit 64
fi
if [[ "$#" -eq 1 ]]; then
  if [[ "$1" != "$report_status_argument" ]]; then
    echo "Unknown argument: $1" >&2
    exit 64
  fi
  report_status=true
fi

cd "$project_worktree_root"
readonly pinned_act_runner_image="$(sed -n 's/^--platform=ubuntu-latest=//p' .actrc)"
if [[ -z "$pinned_act_runner_image" ]]; then
  echo "The pinned ACT runner image is missing from .actrc." >&2
  exit 1
fi

for required_command in act docker git gitleaks node npm; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "Required command not found: $required_command" >&2
    exit 1
  fi
done

if ! docker image inspect "$pinned_act_runner_image" >/dev/null 2>&1; then
  docker pull "$pinned_act_runner_image"
fi
trap 'docker image prune --force >/dev/null' EXIT

act workflow_dispatch --job linux-validation

readonly local_node_environment="${project_worktree_root}/scripts/run-with-node-24.sh"
bash "$local_node_environment" npm ci
bash "$local_node_environment" npm run package:vsix
bash "$local_node_environment" npm run package:verify
bash "$local_node_environment" npm run test:integration:vsix
bash "${project_worktree_root}/scripts/secret-scan.sh"
bash "$local_node_environment" npx --no-install release-it \
  patch \
  --release-version \
  --no-git.requireBranch \
  --no-git.requireCleanWorkingDir \
  --no-git.push \
  --no-github.release

if [[ "$report_status" == true ]]; then
  for required_reporting_command in gh awk; do
    if ! command -v "$required_reporting_command" >/dev/null 2>&1; then
      echo "Required reporting command not found: $required_reporting_command" >&2
      exit 1
    fi
  done

  if [[ -n "$(git status --porcelain=v1 --untracked-files=all)" ]]; then
    echo "Commit all changes before reporting local validation." >&2
    exit 1
  fi

  readonly current_branch_name="$(git branch --show-current)"
  readonly validated_commit_sha="$(git rev-parse HEAD)"
  readonly remote_branch_commit_sha="$(
    git ls-remote --heads origin "refs/heads/${current_branch_name}" | awk '{print $1}'
  )"
  if [[ "$remote_branch_commit_sha" != "$validated_commit_sha" ]]; then
    echo "Push exact commit $validated_commit_sha before reporting local validation." >&2
    exit 1
  fi

  readonly repository_slug="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
  readonly pull_request_title="$(gh pr view "$current_branch_name" --json title --jq .title)"
  readonly pull_request_url="$(gh pr view "$current_branch_name" --json url --jq .url)"
  PULL_REQUEST_TITLE="$pull_request_title" node scripts/validate-pull-request-title.mjs

  gh api --method POST "repos/${repository_slug}/statuses/${validated_commit_sha}" \
    --field state=success \
    --field context="$local_validation_context" \
    --field description="ACT Linux, CodeQL, macOS, audits, and release policy passed" \
    --field target_url="$pull_request_url" >/dev/null
  echo "Reported ${local_validation_context} success for ${validated_commit_sha}."
fi
