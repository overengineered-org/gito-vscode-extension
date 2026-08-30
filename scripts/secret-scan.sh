#!/usr/bin/env bash
set -euo pipefail

readonly project_worktree_root="$(git rev-parse --show-toplevel)"
cd "$project_worktree_root"

gitleaks git . --no-banner --redact --log-level error
git diff --no-ext-diff | gitleaks stdin --no-banner --redact --log-level error
git diff --cached --no-ext-diff | gitleaks stdin --no-banner --redact --log-level error

untracked_project_file_paths=()
while IFS= read -r -d '' untracked_project_file_path; do
  if [[ -f "$untracked_project_file_path" ]]; then
    untracked_project_file_paths+=("$untracked_project_file_path")
  fi
done < <(git ls-files --others --exclude-standard -z)

if [[ "${#untracked_project_file_paths[@]}" -gt 0 ]]; then
  for untracked_project_file_path in "${untracked_project_file_paths[@]}"; do
    printf '\nFILE:%s\n' "$untracked_project_file_path"
    cat -- "$untracked_project_file_path"
  done | gitleaks stdin --no-banner --redact --log-level error
fi
