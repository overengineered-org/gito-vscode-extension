#!/usr/bin/env bash
set -euo pipefail

readonly project_worktree_root="${GITHUB_WORKSPACE:-$(git rev-parse --show-toplevel)}"
readonly codeql_binary_path="${CODEQL_BINARY_PATH:?CODEQL_BINARY_PATH is required}"
readonly codeql_analysis_directory="${CODEQL_ANALYSIS_DIRECTORY:?CODEQL_ANALYSIS_DIRECTORY is required}"
readonly codeql_results_directory="${CODEQL_RESULTS_DIRECTORY:?CODEQL_RESULTS_DIRECTORY is required}"

for protected_directory in "" "/" "$project_worktree_root"; do
  if [[ "$codeql_analysis_directory" == "$protected_directory" ]]; then
    echo "Unsafe CodeQL analysis directory: $codeql_analysis_directory" >&2
    exit 64
  fi
  if [[ "$codeql_results_directory" == "$protected_directory" ]]; then
    echo "Unsafe CodeQL results directory: $codeql_results_directory" >&2
    exit 64
  fi
done

rm -rf -- "$codeql_analysis_directory" "$codeql_results_directory"
mkdir -p "$codeql_analysis_directory" "$codeql_results_directory"

for codeql_language in actions javascript-typescript; do
  codeql_database_directory="${codeql_analysis_directory}/${codeql_language}-database"
  codeql_result_path="${codeql_results_directory}/${codeql_language}.sarif"

  "$codeql_binary_path" database create "$codeql_database_directory" \
    --language="$codeql_language" \
    --source-root="$project_worktree_root" \
    --threads=0
  "$codeql_binary_path" database analyze "$codeql_database_directory" \
    --format=sarif-latest \
    --output="$codeql_result_path" \
    --threads=0
done

node scripts/assert-codeql-results.mjs "$codeql_results_directory"
